import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MsalClientProvider } from '../src/auth/requireAuth.js';
import { SyncService } from '../src/sync/syncService.js';
import { createPutSettingsController } from '../src/controllers/settingsController.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const server = setupServer();
const databases: Database.Database[] = [];
const services: SyncService[] = [];

function putSettings(database: Database.Database, body: unknown, scheduler?: never) {
  let statusCode = 200;
  let payload: unknown;
  const response = {
    status(code: number) { statusCode = code; return this; },
    json(value: unknown) { payload = value; return this; },
  };
  createPutSettingsController(database, scheduler as never)({ body } as never, response as never);
  return { statusCode, payload };
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
afterEach(async () => {
  server.resetHandlers();
  vi.restoreAllMocks();
  for (const service of services.splice(0)) await service.shutdown();
  for (const database of databases.splice(0)) if (database.open) database.close();
});

function createDatabase(): Database.Database {
  const database = new Database(':memory:');
  databases.push(database);
  database.exec(readFileSync(fileURLToPath(new URL('../src/db/migrations/001_init.sql', import.meta.url)), 'utf8'));
  return database;
}

function createService(database: Database.Database) {
  const account = {
    homeAccountId: 'home-id', localAccountId: 'object-id', environment: 'login.microsoftonline.com',
    tenantId: 'tenant-id', username: 'me@example.invalid',
  };
  const client = {
    getTokenCache: () => ({ getAccountByHomeId: vi.fn(async () => account) }),
    acquireTokenSilent: vi.fn(async () => ({ account, accessToken: 'test-token' })),
  };
  const provider = vi.fn(async () => client) as unknown as MsalClientProvider;
  const service = new SyncService(database, provider);
  services.push(service);
  return service;
}

function baseHandlers() {
  return [
    http.get(`${GRAPH}/me`, () => HttpResponse.json({ id: 'object-id', mail: 'me@example.invalid' })),
    http.get(`${GRAPH}/me/mailFolders/inbox`, () => HttpResponse.json({ id: 'inbox-id', displayName: 'Inbox' })),
    http.get(`${GRAPH}/me/mailFolders/sentitems`, () => HttpResponse.json({ id: 'sent-id', displayName: 'Sent Items' })),
    http.get(`${GRAPH}/me/mailFolders/archive`, () => HttpResponse.json({ id: 'archive-id', displayName: 'Archive' })),
  ];
}

function message(id: string, folderId: string, receivedDateTime = new Date().toISOString()) {
  return {
    id,
    conversationId: `conversation-${id}`,
    subject: id,
    from: { emailAddress: { address: 'sender@example.invalid', name: 'Sender' } },
    receivedDateTime,
    sentDateTime: receivedDateTime,
    parentFolderId: folderId,
    isRead: false,
    isDraft: false,
  };
}

async function waitFor(service: SyncService): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (service.status().phase === 'idle' || service.status().phase === 'error') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(service.status().phase).toBe('idle');
}

describe('all in-scope folder sync and window settings', () => {
  it('syncs Inbox, Sent Items and Archive', async () => {
    const database = createDatabase();
    const requested: string[] = [];
    server.use(
      ...baseHandlers(),
      ...['inbox-id', 'sent-id', 'archive-id'].map((folderId) => http.get(`${GRAPH}/me/mailFolders/${folderId}/messages/delta`, () => {
        requested.push(folderId);
        return HttpResponse.json({ value: [message(`message-${folderId}`, folderId)], '@odata.deltaLink': `${GRAPH}/delta?${folderId}` });
      })),
    );
    const service = createService(database);
    service.start('home-id');
    await waitFor(service);
    expect(requested.sort()).toEqual(['archive-id', 'inbox-id', 'sent-id']);
    expect(database.prepare('SELECT id FROM messages ORDER BY id').all()).toHaveLength(3);
  });

  it('keeps a missing Archive warning persistent in status', async () => {
    const database = createDatabase();
    server.use(
      ...baseHandlers().filter((_, index) => index !== 3),
      http.get(`${GRAPH}/me/mailFolders/archive`, () => HttpResponse.json({ error: { code: 'ErrorFolderNotFound', message: 'Not found' } }, { status: 404 })),
      http.get(`${GRAPH}/me/mailFolders/inbox-id/messages/delta`, () => HttpResponse.json({ value: [], '@odata.deltaLink': `${GRAPH}/delta?inbox` })),
      http.get(`${GRAPH}/me/mailFolders/sent-id/messages/delta`, () => HttpResponse.json({ value: [], '@odata.deltaLink': `${GRAPH}/delta?sent` })),
    );
    const service = createService(database);
    service.start('home-id');
    await waitFor(service);
    expect(service.status().warnings).toContain('Archive folder is not available; Archive is not being synced');
    const restartedService = createService(database);
    expect(restartedService.status().warnings).toContain('Archive folder is not available; Archive is not being synced');
    await restartedService.shutdown();
    expect(service.status().warnings).toContain('Archive folder is not available; Archive is not being synced');
  });

  it('raises the window with a full resync while retaining old rows until completion', async () => {
    const database = createDatabase();
    database.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)')
      .run('sync', JSON.stringify({ syncWindowDays: 365, syncIntervalSeconds: 60, folders: ['inbox'] }));
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1_000).toISOString();
    database.prepare("INSERT INTO folders (id, display_name, well_known) VALUES ('inbox-id', 'Inbox', 'inbox')").run();
    database.prepare('INSERT INTO messages (id, folder_id, effective_at, last_seen_sync) VALUES (?, ?, ?, ?)')
      .run('old', 'inbox-id', oldDate, null);
    database.prepare('INSERT INTO sync_state (folder_id, delta_link, window_days, status) VALUES (?, ?, ?, ?)')
      .run('inbox-id', `${GRAPH}/delta?old`, 90, 'idle');
    const requested: string[] = [];
    server.use(
      ...baseHandlers(),
      http.get(`${GRAPH}/me/mailFolders/inbox-id/messages/delta`, ({ request }) => {
        requested.push(request.url);
        return HttpResponse.json({ value: [message('old', 'inbox-id', oldDate)], '@odata.deltaLink': `${GRAPH}/delta?rebuilt` });
      }),
      http.get(`${GRAPH}/me/mailFolders/sent-id/messages/delta`, () => HttpResponse.json({ value: [], '@odata.deltaLink': `${GRAPH}/delta?sent` })),
      http.get(`${GRAPH}/me/mailFolders/archive-id/messages/delta`, () => HttpResponse.json({ value: [], '@odata.deltaLink': `${GRAPH}/delta?archive` })),
    );
    const service = createService(database);
    service.start('home-id');
    await waitFor(service);
    expect(requested).toHaveLength(1);
    expect(requested[0]).not.toContain('opaque=old');
    expect(database.prepare('SELECT id FROM messages WHERE id = ?').get('old')).toBeDefined();
    expect(database.prepare('SELECT delta_link, window_days FROM sync_state WHERE folder_id = ?').get('inbox-id')).toEqual({
      delta_link: `${GRAPH}/delta?rebuilt`, window_days: 365,
    });
  });

  it('lowers the window using local retention only, without clearing delta links', async () => {
    const database = createDatabase();
    const now = new Date();
    const old = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1_000).toISOString();
    const recent = now.toISOString();
    database.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)')
      .run('sync', JSON.stringify({ syncWindowDays: 365, syncIntervalSeconds: 60, folders: ['inbox'] }));
    database.prepare('INSERT INTO messages (id, folder_id, effective_at) VALUES (?, ?, ?)').run('old', 'inbox-id', old);
    database.prepare('INSERT INTO messages (id, folder_id, effective_at) VALUES (?, ?, ?)').run('recent', 'inbox-id', recent);
    database.prepare('INSERT INTO sync_state (folder_id, delta_link, window_days) VALUES (?, ?, ?)')
      .run('inbox-id', `${GRAPH}/delta?keep`, 365);
    expect(putSettings(database, { syncWindowDays: 90 }).statusCode).toBe(200);
    expect(database.prepare('SELECT id FROM messages').all()).toEqual([{ id: 'recent' }]);
    expect(database.prepare('SELECT delta_link FROM sync_state').get()).toEqual({ delta_link: `${GRAPH}/delta?keep` });
  });

  it('rejects invalid sync settings and clears all deltas when the window increases', async () => {
    const database = createDatabase();
    database.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)')
      .run('sync', JSON.stringify({ syncWindowDays: 90, syncIntervalSeconds: 60, folders: ['inbox'] }));
    database.prepare("INSERT INTO sync_state (folder_id, delta_link, resume_link, window_days) VALUES ('inbox-id', 'delta', 'resume', 90)").run();
    expect(putSettings(database, { syncIntervalSeconds: 10 }).statusCode).toBe(400);
    expect(putSettings(database, { syncWindowDays: 365 }).statusCode).toBe(200);
    expect(database.prepare('SELECT delta_link, resume_link, window_days, status FROM sync_state').get()).toEqual({
      delta_link: null, resume_link: null, window_days: 365, status: 'resyncing',
    });
  });
});
