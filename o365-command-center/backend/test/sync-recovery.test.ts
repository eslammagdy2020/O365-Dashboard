import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MsalClientProvider } from '../src/auth/requireAuth.js';
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

function createService(database: Database.Database, options: { silentFailure?: boolean } = {}) {
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
      return { account, accessToken: 'test-token' };
    }),
  };
  const provider = vi.fn(async () => client) as unknown as MsalClientProvider;
  const service = new SyncService(database, provider);
  services.push(service);
  return { service, client };
}

const row = (id: string) => ({
  id,
  conversationId: `conversation-${id}`,
  subject: `Subject ${id}`,
  from: { emailAddress: { address: 'sender@example.invalid', name: 'Sender' } },
  receivedDateTime: '2026-11-22T10:00:00Z',
  sentDateTime: '2026-11-22T09:59:00Z',
  isRead: false,
  importance: 'normal',
  hasAttachments: false,
  flag: { flagStatus: 'notFlagged' },
  categories: [],
  bodyPreview: 'Preview',
  parentFolderId: 'inbox-id',
  isDraft: false,
  webLink: 'https://outlook.example.invalid/message',
});

async function waitFor(service: SyncService, phase: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (service.status().phase === phase) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(service.status().phase).toBe(phase);
}

function commonGraphHandlers() {
  return [
    http.get(`${GRAPH}/me/mailFolders/inbox`, () =>
      HttpResponse.json({ id: 'inbox-id', displayName: 'Inbox' }),
    ),
    http.get(`${GRAPH}/me`, () =>
      HttpResponse.json({ id: 'object-id', mail: 'me@example.invalid' }),
    ),
  ];
}

describe('sync restart and recovery', () => {
  it('commits each page and its continuation atomically', () => {
    const database = createDatabase();
    database.exec(`
      CREATE TRIGGER reject_sync_progress BEFORE INSERT ON sync_state
      BEGIN SELECT RAISE(ABORT, 'injected page commit failure'); END;
    `);

    expect(() =>
      applyDeltaPage(
        database,
        'inbox-id',
        [row('must-rollback')],
        { nextLink: `${GRAPH}/delta?opaque=resume`, windowDays: 90 },
        [],
      ),
    ).toThrow('injected page commit failure');
    expect(database.prepare('SELECT id FROM messages').all()).toEqual([]);
    expect(database.prepare('SELECT folder_id FROM sync_state').all()).toEqual([]);
  });

  it('retains a failed initial page continuation and resumes it on the next run', async () => {
    const database = createDatabase();
    const next = `${GRAPH}/delta?opaque=resume`;
    let failSecondPage = true;
    const requested: string[] = [];
    server.use(
      ...commonGraphHandlers(),
      http.get(`${GRAPH}/me/mailFolders/inbox-id/messages/delta`, ({ request }) => {
        requested.push(request.url);
        return HttpResponse.json({ value: [row('first')], '@odata.nextLink': next });
      }),
      http.get(`${GRAPH}/delta`, ({ request }) => {
        requested.push(request.url);
        if (failSecondPage) return HttpResponse.error();
        return HttpResponse.json({
          value: [row('second')],
          '@odata.deltaLink': `${GRAPH}/delta?opaque=final`,
        });
      }),
    );
    const { service } = createService(database);
    service.start('home-id');
    await waitFor(service, 'error');
    expect(database.prepare('SELECT resume_link FROM sync_state').get()).toEqual({
      resume_link: next,
    });
    expect(service.status().warnings).toContain('Inbox sync failed (network_error)');

    failSecondPage = false;
    await service.shutdown();
    const { service: restarted } = createService(database);
    restarted.start('home-id');
    await waitFor(restarted, 'idle');
    expect(requested.filter((url) => url.includes('/delta?opaque=resume'))).toHaveLength(2);
    expect(database.prepare('SELECT id FROM messages ORDER BY id').all()).toEqual([
      { id: 'first' },
      { id: 'second' },
    ]);
  });

  it('marks silent-auth failure as login_required and reports it as a warning', async () => {
    const database = createDatabase();
    database
      .prepare(
        "INSERT INTO folders (id, display_name, well_known) VALUES ('inbox-id', 'Inbox', 'inbox')",
      )
      .run();
    const { service, client } = createService(database, { silentFailure: true });
    service.start('home-id');
    await waitFor(service, 'error');
    expect(client.acquireTokenSilent).toHaveBeenCalledTimes(1);
    expect(database.prepare('SELECT status, error FROM sync_state').get()).toEqual({
      status: 'login_required',
      error: 'Sign in is required to sync the inbox',
    });
    expect(service.status().warnings).toContain('Sign in is required to sync the inbox');
  });

  it('restores the latest persisted failure as lastError after restart', async () => {
    const database = createDatabase();
    database
      .prepare(
        "INSERT INTO folders (id, display_name, well_known) VALUES ('inbox-id', 'Inbox', 'inbox')",
      )
      .run();
    const { service } = createService(database, { silentFailure: true });
    service.start('home-id');
    await waitFor(service, 'error');
    await service.shutdown();

    const { service: restarted } = createService(database);
    expect(restarted.status().lastError).toContain('Sign in is required to sync the inbox');
    expect(restarted.status().warnings).toContain('Sign in is required to sync the inbox');
  });

  it('keeps stale rows until a 410 full resync finishes, then removes unseen rows', async () => {
    const database = createDatabase();
    applyDeltaPage(
      database,
      'inbox-id',
      [row('stale'), row('retained')],
      {
        deltaLink: `${GRAPH}/delta?opaque=expired`,
        windowDays: 90,
      },
      [],
    );
    const resume = `${GRAPH}/delta?opaque=full-resume`;
    let failResync = true;
    let firstDelta = true;
    server.use(
      ...commonGraphHandlers(),
      http.get(`${GRAPH}/delta`, ({ request }) => {
        const url = request.url;
        if (firstDelta && url.includes('opaque=expired')) {
          firstDelta = false;
          return HttpResponse.json(
            { error: { code: 'syncStateNotFound', message: 'Invalid delta state' } },
            { status: 410 },
          );
        }
        if (failResync) {
          failResync = false;
          return HttpResponse.error();
        }
        return HttpResponse.json({
          value: [row('retained')],
          '@odata.deltaLink': `${GRAPH}/delta?opaque=rebuilt`,
        });
      }),
      http.get(`${GRAPH}/me/mailFolders/inbox-id/messages/delta`, () =>
        HttpResponse.json({ value: [row('retained')], '@odata.nextLink': resume }),
      ),
    );
    const { service } = createService(database);
    service.start('home-id');
    await waitFor(service, 'error');
    expect(database.prepare('SELECT id FROM messages ORDER BY id').all()).toEqual([
      { id: 'retained' },
      { id: 'stale' },
    ]);
    expect(database.prepare('SELECT resume_link, status FROM sync_state').get()).toEqual({
      resume_link: resume,
      status: 'error',
    });

    await service.shutdown();
    const { service: restarted } = createService(database);
    restarted.start('home-id');
    await waitFor(restarted, 'idle');
    expect(database.prepare('SELECT id FROM messages ORDER BY id').all()).toEqual([
      { id: 'retained' },
    ]);
    expect(
      database.prepare('SELECT delta_link, resume_link, status FROM sync_state').get(),
    ).toEqual({
      delta_link: `${GRAPH}/delta?opaque=rebuilt`,
      resume_link: null,
      status: 'idle',
    });
  });
});
