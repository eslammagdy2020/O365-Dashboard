import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MsalClientProvider } from '../src/auth/requireAuth.js';
import { createPutSettingsController } from '../src/controllers/settingsController.js';
import { SyncService } from '../src/sync/syncService.js';
import { applyDeltaPage } from '../src/sync/deltaApplier.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const server = setupServer();
const databases: Database.Database[] = [];
const services: SyncService[] = [];

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
afterEach(async () => {
  server.resetHandlers();
  vi.restoreAllMocks();
  for (const service of services.splice(0)) await service.shutdown();
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
});

function createDatabase(): Database.Database {
  const database = new Database(':memory:');
  databases.push(database);
  database.exec(
    readFileSync(
      fileURLToPath(new URL('../src/db/migrations/001_init.sql', import.meta.url)),
      'utf8',
    ),
  );
  return database;
}

function createService(
  database: Database.Database,
  options: { silentFailure?: boolean } = {},
): SyncService {
  const account = {
    homeAccountId: 'home-id',
    localAccountId: 'object-id',
    environment: 'login.microsoftonline.com',
    tenantId: 'tenant-id',
    username: 'me@example.invalid',
  };
  const client = {
    getTokenCache: () => ({ getAccountByHomeId: vi.fn(async () => account) }),
    acquireTokenSilent: vi.fn(async () => {
      if (options.silentFailure) throw new Error('interaction_required');
      return { account, accessToken: 'mock-token' };
    }),
  };
  const service = new SyncService(
    database,
    vi.fn(async () => client) as unknown as MsalClientProvider,
  );
  services.push(service);
  return service;
}

function baseHandlers() {
  return [
    http.get(`${GRAPH}/me`, () =>
      HttpResponse.json({ id: 'object-id', mail: 'me@example.invalid' }),
    ),
    http.get(`${GRAPH}/me/mailFolders/inbox`, () =>
      HttpResponse.json({ id: 'inbox-id', displayName: 'Inbox' }),
    ),
    http.get(`${GRAPH}/me/mailFolders/sentitems`, () =>
      HttpResponse.json({ id: 'sent-id', displayName: 'Sent Items' }),
    ),
    http.get(`${GRAPH}/me/mailFolders/archive`, () =>
      HttpResponse.json({ id: 'archive-id', displayName: 'Archive' }),
    ),
  ];
}

function message(id: string, folderId = 'inbox-id', receivedDateTime = '2026-11-22T10:00:00Z') {
  return {
    id,
    conversationId: `conversation-${id}`,
    subject: `Synthetic ${id}`,
    from: { emailAddress: { address: 'sender@example.invalid', name: 'Sender' } },
    receivedDateTime,
    sentDateTime: receivedDateTime,
    parentFolderId: folderId,
    isRead: false,
    isDraft: false,
  };
}

async function waitFor(service: SyncService, expected: 'idle' | 'error'): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (service.status().phase === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(service.status().phase).toBe(expected);
}

function setWindow(database: Database.Database, body: unknown): number {
  let status = 200;
  createPutSettingsController(database, undefined as never)(
    { body } as never,
    {
      status(code: number) {
        status = code;
        return this;
      },
      json() {
        return this;
      },
    } as never,
  );
  return status;
}

describe('sync resilience with mocked Graph', () => {
  it('resumes an interrupted initial sync after a network drop without losing saved pages', async () => {
    const database = createDatabase();
    const continuation = `${GRAPH}/delta?opaque=resume`;
    let dropSecondPage = true;
    const requests: string[] = [];
    server.use(
      ...baseHandlers(),
      http.get(`${GRAPH}/me/mailFolders/sent-id/messages/delta`, () =>
        HttpResponse.json({ value: [], '@odata.deltaLink': `${GRAPH}/delta?opaque=sent` }),
      ),
      http.get(`${GRAPH}/me/mailFolders/archive-id/messages/delta`, () =>
        HttpResponse.json({ value: [], '@odata.deltaLink': `${GRAPH}/delta?opaque=archive` }),
      ),
      http.get(`${GRAPH}/me/mailFolders/inbox-id/messages/delta`, ({ request }) => {
        requests.push(request.url);
        return HttpResponse.json({
          value: [message('saved-page')],
          '@odata.nextLink': continuation,
        });
      }),
      http.get(`${GRAPH}/delta`, ({ request }) => {
        requests.push(request.url);
        if (dropSecondPage) return HttpResponse.error();
        return HttpResponse.json({
          value: [message('resumed-page')],
          '@odata.deltaLink': `${GRAPH}/delta?opaque=final`,
        });
      }),
    );

    const firstRun = createService(database);
    firstRun.start('home-id');
    await waitFor(firstRun, 'error');
    expect(database.prepare('SELECT id FROM messages ORDER BY id').all()).toEqual([
      { id: 'saved-page' },
    ]);
    expect(
      database.prepare('SELECT resume_link FROM sync_state WHERE folder_id = ?').get('inbox-id'),
    ).toEqual({ resume_link: continuation });
    expect(firstRun.status().warnings).toContain('Inbox sync failed (network_error)');
    await firstRun.shutdown();

    dropSecondPage = false;
    const restarted = createService(database);
    restarted.start('home-id');
    await waitFor(restarted, 'idle');
    expect(requests.filter((url) => url.includes('opaque=resume'))).toHaveLength(2);
    expect(database.prepare('SELECT id FROM messages ORDER BY id').all()).toEqual([
      { id: 'resumed-page' },
      { id: 'saved-page' },
    ]);
  });

  it('reports expired silent authentication and retains cached rows without a database reset', async () => {
    const database = createDatabase();
    database
      .prepare('INSERT INTO folders (id, display_name, well_known) VALUES (?, ?, ?)')
      .run('inbox-id', 'Inbox', 'inbox');
    database
      .prepare('INSERT INTO messages (id, folder_id, subject) VALUES (?, ?, ?)')
      .run('cached-message', 'inbox-id', 'Still cached');
    const service = createService(database, { silentFailure: true });
    service.start('home-id');
    await waitFor(service, 'error');
    expect(service.status().warnings).toContain('Sign in is required to sync the inbox');
    expect(database.prepare('SELECT id, subject FROM messages').all()).toEqual([
      { id: 'cached-message', subject: 'Still cached' },
    ]);
    expect(
      database.prepare('SELECT status FROM sync_state WHERE folder_id = ?').get('inbox-id'),
    ).toEqual({ status: 'login_required' });
  });

  it('rolls back message rows when saving page progress fails in the same transaction', () => {
    const database = createDatabase();
    database.exec(`CREATE TRIGGER reject_page_progress BEFORE INSERT ON sync_state
      BEGIN SELECT RAISE(ABORT, 'injected progress failure'); END;`);
    expect(() =>
      applyDeltaPage(
        database,
        'inbox-id',
        [message('must-rollback')],
        { nextLink: `${GRAPH}/delta?opaque=resume`, windowDays: 90 },
        [],
      ),
    ).toThrow('injected progress failure');
    expect(database.prepare('SELECT id FROM messages').all()).toEqual([]);
    expect(database.prepare('SELECT folder_id FROM sync_state').all()).toEqual([]);
  });

  it('runs a full resync when the window rises and only local cleanup when it falls', async () => {
    const database = createDatabase();
    database
      .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)')
      .run(
        'sync',
        JSON.stringify({ syncWindowDays: 90, syncIntervalSeconds: 60, folders: ['inbox'] }),
      );
    database
      .prepare('INSERT INTO folders (id, display_name, well_known) VALUES (?, ?, ?)')
      .run('inbox-id', 'Inbox', 'inbox');
    database
      .prepare('INSERT INTO messages (id, folder_id, effective_at) VALUES (?, ?, ?)')
      .run('older-cached', 'inbox-id', new Date(Date.now() - 200 * 86_400_000).toISOString());
    database
      .prepare('INSERT INTO messages (id, folder_id, effective_at) VALUES (?, ?, ?)')
      .run('recent-cached', 'inbox-id', new Date().toISOString());
    database
      .prepare(
        'INSERT INTO sync_state (folder_id, delta_link, window_days, status) VALUES (?, ?, ?, ?)',
      )
      .run('inbox-id', `${GRAPH}/delta?opaque=old-window`, 90, 'idle');
    expect(setWindow(database, { syncWindowDays: 365 })).toBe(200);

    const requests: string[] = [];
    server.use(
      ...baseHandlers(),
      http.get(`${GRAPH}/me/mailFolders/inbox-id/messages/delta`, ({ request }) => {
        requests.push(request.url);
        return HttpResponse.json({
          value: [
            message(
              'older-cached',
              'inbox-id',
              new Date(Date.now() - 200 * 86_400_000).toISOString(),
            ),
            message('recent-cached', 'inbox-id', new Date().toISOString()),
          ],
          '@odata.deltaLink': `${GRAPH}/delta?opaque=raised`,
        });
      }),
      http.get(`${GRAPH}/me/mailFolders/sent-id/messages/delta`, () =>
        HttpResponse.json({ value: [], '@odata.deltaLink': `${GRAPH}/delta?sent` }),
      ),
      http.get(`${GRAPH}/me/mailFolders/archive-id/messages/delta`, () =>
        HttpResponse.json({ value: [], '@odata.deltaLink': `${GRAPH}/delta?archive` }),
      ),
    );
    const service = createService(database);
    service.start('home-id');
    await waitFor(service, 'idle');
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toContain('old-window');
    expect(
      database
        .prepare('SELECT delta_link, window_days FROM sync_state WHERE folder_id = ?')
        .get('inbox-id'),
    ).toEqual({ delta_link: `${GRAPH}/delta?opaque=raised`, window_days: 365 });

    expect(setWindow(database, { syncWindowDays: 90 })).toBe(200);
    expect(database.prepare('SELECT id FROM messages ORDER BY id').all()).toEqual([
      { id: 'recent-cached' },
    ]);
    expect(
      database.prepare('SELECT delta_link FROM sync_state WHERE folder_id = ?').get('inbox-id'),
    ).toEqual({ delta_link: `${GRAPH}/delta?opaque=raised` });
  });
});
