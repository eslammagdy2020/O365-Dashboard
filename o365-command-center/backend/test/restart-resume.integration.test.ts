import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import request from 'supertest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/env.js';
import { loadConfig } from '../src/config/env.js';
import type { MsalClientProvider } from '../src/auth/requireAuth.js';
import { createApp } from '../src/app.js';
import { executeBatch } from '../src/graph/batch.js';
import { GraphClient } from '../src/graph/graphClient.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const ENTRA_AUTHORIZE =
  'https://login.microsoftonline.com/mock-tenant-id/oauth2/v2.0/authorize';
const FRONTEND_URL = 'http://localhost:5173';
const server = setupServer();
const tempDirectories: string[] = [];
let deltaScenario: 'inbox-first' | 'archive-first' | null = null;

const account = {
  homeAccountId: 'mock-home-account',
  localAccountId: 'mock-object-id',
  name: 'Mock User',
  environment: 'login.microsoftonline.com',
  tenantId: 'mock-tenant-id',
  username: 'mock@example.invalid',
};

const firstPage = [
  'keep-1',
  'move-a1',
  'keep-5',
].map((id) => message(id, 'inbox-id'));
const secondPage = ['keep-2', 'keep-3', 'keep-4'].map((id) => message(id, 'inbox-id'));

beforeAll(() =>
  server.listen({
    onUnhandledRequest: (request, print) => {
      const hostname = new URL(request.url).hostname;
      if (hostname === '127.0.0.1' || hostname === 'localhost') return;
      print.error();
    },
  }),
);
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  deltaScenario = null;
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Milestone 1 restart and resume integration', () => {
  it(
    'resumes an interrupted sign-in sync and converges to the uninterrupted grid state',
    { timeout: 30_000 },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'occ-t10-'));
      tempDirectories.push(directory);
      const config = testConfig(directory);
      let database = createDatabase(join(directory, 'data.sqlite'));
      let firstApp: ReturnType<typeof createApp> | undefined;
      let restartedApp: ReturnType<typeof createApp> | undefined;
      let controlApp: ReturnType<typeof createApp> | undefined;
      let controlDatabase: Database.Database | undefined;
      const resumeUrl = `${GRAPH}/delta?opaque=inbox-page-2`;
      const resumeLinkReached = deferred<void>();
      const firstWorldRequests: string[] = [];
      let holdSecondPage = true;

      server.use(
        http.get(ENTRA_AUTHORIZE, ({ request: entraRequest }) => {
          const url = new URL(entraRequest.url);
          return HttpResponse.json({
            code: 'mock-authorization-code',
            state: url.searchParams.get('state'),
          });
        }),
        ...graphHandlers({
          requested: firstWorldRequests,
          interruptAtResume: resumeUrl,
          onResumePage: () => resumeLinkReached.resolve(),
          shouldHoldSecondPage: () => holdSecondPage,
        }),
      );

      try {
        const provider = createMsalProvider();
        firstApp = createApp(config, database, provider);
        const cookie = await signIn(firstApp);

        await postApi(firstApp, cookie, '/api/sync/run').expect(202);
        await resumeLinkReached.promise;
        await firstApp.locals.shutdown();
        firstApp = undefined;

        // Reopening the same SQLite file simulates a new application process.
        database = createDatabase(join(directory, 'data.sqlite'), false);
        expect(
          database.prepare('SELECT id FROM messages ORDER BY id').all(),
        ).toEqual(firstPage.map(({ id }) => ({ id })).sort((left, right) => left.id.localeCompare(right.id)));
        expect(database.prepare('SELECT resume_link FROM sync_state WHERE folder_id = ?').get('inbox-id'))
          .toEqual({ resume_link: resumeUrl });

        holdSecondPage = false;
        restartedApp = createApp(config, database, provider);
        restartedApp.locals.initialise();
        await getApi(restartedApp, cookie, '/auth/me').expect(200);
        await waitForIdle(restartedApp, cookie);

        const resumedRequests = firstWorldRequests.filter((url) => url === resumeUrl);
        expect(resumedRequests).toHaveLength(2);
        expect(
          firstWorldRequests.filter((url) => url.includes('/inbox-id/messages/delta')),
        ).toHaveLength(1);
        expect(database.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 6 });
        expect(
          database.prepare('SELECT resume_link FROM sync_state WHERE folder_id = ?').get('inbox-id'),
        ).toEqual({ resume_link: null });

        await exerciseA1(restartedApp, cookie, database);
        const resumedRows = readRows(database);
        const resumedGrid = await readInboxGrid(restartedApp, cookie);
        expect(resumedRows).toHaveLength(6);
        expect(resumedGrid.total).toBe(5);
        expect(resumedGrid.items.map((row) => row.id).sort()).toEqual(
          ['keep-1', 'keep-2', 'keep-3', 'keep-4', 'keep-5'],
        );
        expect(
          database
            .prepare('SELECT id, COUNT(*) AS count FROM messages GROUP BY id HAVING COUNT(*) > 1')
            .all(),
        ).toEqual([]);
        expect(
          database
            .prepare('SELECT COUNT(*) AS count FROM sync_state WHERE resume_link IS NOT NULL')
            .get(),
        ).toEqual({ count: 0 });
        const resumedStatus = await getStatus(restartedApp, cookie);
        expect(resumedStatus.phase).toBe('idle');
        expect(resumedStatus.lastError).toBeNull();
        expect(resumedStatus.warnings).toEqual([]);

        await restartedApp.locals.shutdown();
        restartedApp = undefined;

        // The control run is a fresh uninterrupted app against the same mocked Graph dataset.
        controlDatabase = createDatabase(join(directory, 'control.sqlite'));
        controlApp = createApp(config, controlDatabase, provider);
        const controlCookie = await signIn(controlApp);
        await postApi(controlApp, controlCookie, '/api/sync/run').expect(202);
        await waitForIdle(controlApp, controlCookie);
        await exerciseA1(controlApp, controlCookie, controlDatabase);

        expect(readRows(controlDatabase)).toEqual(resumedRows);
        const controlGrid = await readInboxGrid(controlApp, controlCookie);
        expect(controlGrid).toEqual(resumedGrid);
        const controlStatus = await getStatus(controlApp, controlCookie);
        expect(controlStatus.phase).toBe('idle');
        expect(controlStatus.lastError).toBeNull();
        expect(controlStatus.warnings).toEqual([]);

        await controlApp.locals.shutdown();
        controlApp = undefined;
        await verifyBatchConcurrency(provider);
      } finally {
        // shutdown() also closes the supplied database, matching server lifecycle behavior.
        if (firstApp) await firstApp.locals.shutdown();
        if (restartedApp) await restartedApp.locals.shutdown();
        if (controlApp) await controlApp.locals.shutdown();
        if (database.open) database.close();
        if (controlDatabase?.open) controlDatabase.close();
      }
    },
  );
});

function testConfig(dataDirectory: string): AppConfig {
  return loadConfig({
    SESSION_SECRET: '0123456789abcdef0123456789abcdef',
    LOCALAPPDATA: dataDirectory,
    DATA_DIR: dataDirectory,
    CLIENT_ID: 'mock-client-id',
    TENANT_ID: 'mock-tenant-id',
    FRONTEND_URL,
    REDIRECT_URI: 'http://localhost:5000/auth/callback',
  });
}

function createDatabase(path: string, migrate = true): Database.Database {
  const database = new Database(path);
  if (migrate) {
    database.exec(
      readFileSync(
        fileURLToPath(new URL('../src/db/migrations/001_init.sql', import.meta.url)),
        'utf8',
      ),
    );
  }
  return database;
}

function createMsalProvider(): MsalClientProvider {
  const tokenCache = {
    getAccountByHomeId: vi.fn(async (id: string) => (id === account.homeAccountId ? account : null)),
    removeAccount: vi.fn(async () => undefined),
  };
  const client = {
    getAuthCodeUrl: vi.fn(async (options: Record<string, string | string[]>) => {
      const url = new URL(ENTRA_AUTHORIZE);
      for (const [key, value] of Object.entries(options)) {
        const parameter = key === 'codeChallenge' ? 'code_challenge' :
          key === 'codeChallengeMethod' ? 'code_challenge_method' : key;
        url.searchParams.set(parameter, Array.isArray(value) ? value.join(' ') : value);
      }
      return url.toString();
    }),
    acquireTokenByCode: vi.fn(async () => ({ account, accessToken: 'mock-access-token' })),
    getTokenCache: () => tokenCache,
    acquireTokenSilent: vi.fn(async () => ({ account, accessToken: 'mock-access-token' })),
  };
  return vi.fn(async () => client) as unknown as MsalClientProvider;
}

async function signIn(app: ReturnType<typeof createApp>): Promise<string> {
  const login = await request(app).get('/auth/login').expect(302);
  const authorizeUrl = new URL(login.headers.location as string);
  const entraResponse = await fetch(authorizeUrl);
  expect(entraResponse.ok).toBe(true);
  const authorization = (await entraResponse.json()) as { code: string; state: string };
  expect(authorizeUrl.searchParams.get('code_challenge')).toBeTruthy();
  const callback = await request(app)
    .get(`/auth/callback?code=${authorization.code}&state=${encodeURIComponent(authorization.state)}`)
    .set('Cookie', login.headers['set-cookie'][0].split(';')[0])
    .expect(302);
  return callback.headers['set-cookie'][0].split(';')[0];
}

type GraphHandlerOptions = {
  requested: string[];
  interruptAtResume?: string;
  onResumePage?: () => void;
  shouldHoldSecondPage?: () => boolean;
};

function graphHandlers(options: GraphHandlerOptions) {
  return [
    http.get(`${GRAPH}/me`, () => HttpResponse.json({ id: 'mock-object-id', mail: 'mock@example.invalid' })),
    http.get(`${GRAPH}/me/mailFolders/archive`, () =>
      HttpResponse.json({ id: 'archive-id', displayName: 'Archive' }),
    ),
    http.get(`${GRAPH}/me/mailFolders/inbox`, () =>
      HttpResponse.json({ id: 'inbox-id', displayName: 'Inbox' }),
    ),
    http.get(`${GRAPH}/me/mailFolders/sentitems`, () =>
      HttpResponse.json({ id: 'sent-id', displayName: 'Sent Items' }),
    ),
    http.get(`${GRAPH}/me/mailFolders/inbox-id/messages/delta`, ({ request }) => {
      options.requested.push(request.url);
      return HttpResponse.json({ value: firstPage, '@odata.nextLink': options.interruptAtResume });
    }),
    http.get(`${GRAPH}/me/mailFolders/sent-id/messages/delta`, ({ request }) => {
      options.requested.push(request.url);
      return HttpResponse.json({
        value: [],
        '@odata.deltaLink': `${GRAPH}/delta?folder=sent&token=incremental`,
      });
    }),
    http.get(`${GRAPH}/me/mailFolders/archive-id/messages/delta`, ({ request }) => {
      options.requested.push(request.url);
      return HttpResponse.json({
        value: [],
        '@odata.deltaLink': `${GRAPH}/delta?folder=archive&token=incremental`,
      });
    }),
    http.get(`${GRAPH}/delta`, async ({ request }) => {
      const url = new URL(request.url);
      options.requested.push(request.url);
      if (url.searchParams.get('opaque') === 'inbox-page-2') {
        options.onResumePage?.();
        if (options.shouldHoldSecondPage?.()) {
          await new Promise<void>((resolve) => {
            if (request.signal.aborted) resolve();
            else request.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return HttpResponse.error();
        }
        return HttpResponse.json({
          value: secondPage,
          '@odata.deltaLink': `${GRAPH}/delta?folder=inbox&token=incremental`,
        });
      }

      const folder = url.searchParams.get('folder');
      if (!folder) return HttpResponse.json({ value: [] });
      if (folder === 'sent') {
        return HttpResponse.json({
          value: [],
          '@odata.deltaLink': `${GRAPH}/delta?folder=sent&token=incremental`,
        });
      }
      if (!deltaScenario) return HttpResponse.json({ value: [] });
      if (folder === 'inbox') {
        return HttpResponse.json({
          value: [{ id: 'move-a1', '@removed': { reason: 'changed' } }],
          '@odata.deltaLink': `${GRAPH}/delta?folder=inbox&token=incremental`,
        });
      }
      if (folder === 'archive') {
        return HttpResponse.json({
          value: [message('move-a1', 'archive-id')],
          '@odata.deltaLink': `${GRAPH}/delta?folder=archive&token=incremental`,
        });
      }
      return HttpResponse.json({ value: [] });
    }),
  ];
}

async function exerciseA1(
  app: ReturnType<typeof createApp>,
  cookie: string,
  database: Database.Database,
): Promise<void> {
  setSyncFolderOrder(database, ['inbox', 'archive', 'sentitems']);
  deltaScenario = 'inbox-first';
  await runSync(app, cookie);
  const afterInboxRemovalFirst = readRows(database);
  expect(folderOf(database, 'move-a1')).toBe('archive-id');
  await runSync(app, cookie);
  expect(readRows(database)).toEqual(afterInboxRemovalFirst);

  database.prepare("UPDATE messages SET folder_id = 'inbox-id' WHERE id = ?").run('move-a1');
  setSyncFolderOrder(database, ['archive', 'inbox', 'sentitems']);
  deltaScenario = 'archive-first';
  await runSync(app, cookie);
  const afterArchiveAddedFirst = readRows(database);
  expect(folderOf(database, 'move-a1')).toBe('archive-id');
  expect(afterArchiveAddedFirst).toEqual(afterInboxRemovalFirst);
  await runSync(app, cookie);
  expect(readRows(database)).toEqual(afterArchiveAddedFirst);
  deltaScenario = null;
}

function setSyncFolderOrder(database: Database.Database, folders: string[]): void {
  database
    .prepare(
      `INSERT INTO settings (key, value_json) VALUES ('sync', ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    )
    .run(JSON.stringify({ syncWindowDays: 90, syncIntervalSeconds: 60, folders }));
}

async function runSync(app: ReturnType<typeof createApp>, cookie: string): Promise<void> {
  await postApi(app, cookie, '/api/sync/run').expect(202);
  await waitForIdle(app, cookie);
}

async function waitForIdle(app: ReturnType<typeof createApp>, cookie: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await getStatus(app, cookie);
    if (status.phase === 'idle') return;
    if (status.phase === 'error') throw new Error(`Sync ended with an error: ${status.lastError}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for sync to become idle');
}

async function getStatus(app: ReturnType<typeof createApp>, cookie: string) {
  const response = await getApi(app, cookie, '/api/sync/status').expect(200);
  return response.body.data as {
    phase: string;
    lastError: string | null;
    warnings: string[];
  };
}

async function readInboxGrid(app: ReturnType<typeof createApp>, cookie: string) {
  const response = await getApi(app, cookie, '/api/messages?view=inbox&limit=20').expect(200);
  return response.body as { items: Array<{ id: string }>; total: number; offset: number; limit: number };
}

function getApi(app: ReturnType<typeof createApp>, cookie: string, path: string) {
  return request(app).get(path).set('Cookie', cookie);
}

function postApi(app: ReturnType<typeof createApp>, cookie: string, path: string) {
  return request(app)
    .post(path)
    .set('Cookie', cookie)
    .set('Origin', FRONTEND_URL)
    .set('X-Requested-With', 'occ');
}

function readRows(database: Database.Database) {
  return database
    .prepare(
      `SELECT id, conversation_id, folder_id, subject, from_address, from_name,
        received_at, sent_at, effective_at, is_read, importance, has_attachments,
        flag_status, categories_json, body_preview, inference_class, web_link,
        is_draft, is_from_me, base_score, score, score_breakdown_json, auto_categories_json
       FROM messages ORDER BY id`,
    )
    .all();
}

function folderOf(database: Database.Database, id: string): string | undefined {
  return (database.prepare('SELECT folder_id FROM messages WHERE id = ?').get(id) as
    | { folder_id: string }
    | undefined)?.folder_id;
}

function message(id: string, folderId: string) {
  return {
    id,
    conversationId: `conversation-${id}`,
    subject: `Subject ${id}`,
    from: { emailAddress: { address: `sender-${id}@example.invalid`, name: `Sender ${id}` } },
    receivedDateTime: '2026-11-21T10:00:00.000Z',
    sentDateTime: '2026-11-21T09:59:00.000Z',
    isRead: false,
    importance: 'normal' as const,
    hasAttachments: false,
    flag: { flagStatus: 'notFlagged' as const },
    categories: [],
    bodyPreview: `Preview ${id}`,
    parentFolderId: folderId,
    isDraft: false,
    webLink: `https://outlook.example.invalid/message/${id}`,
  };
}

async function verifyBatchConcurrency(provider: MsalClientProvider): Promise<void> {
  let activeOperations = 0;
  let maximumOperations = 0;
  const batchCalls: string[][] = [];
  const retryDelays: number[] = [];
  server.use(
    http.post(`${GRAPH}/$batch`, async ({ request }) => {
      const body = (await request.json()) as { requests: Array<{ id: string }> };
      const ids = body.requests.map(({ id }) => id);
      batchCalls.push(ids);
      activeOperations += ids.length;
      maximumOperations = Math.max(maximumOperations, activeOperations);
      await new Promise((resolve) => setTimeout(resolve, 15));
      activeOperations -= ids.length;
      return HttpResponse.json({
        responses: ids.map((id) => ({
          id,
          status: id === 'throttled-item' && batchCalls.length === 1 ? 429 : 200,
          ...(id === 'throttled-item' && batchCalls.length === 1
            ? { headers: { 'Retry-After': '1' } }
            : {}),
        })),
      });
    }),
    http.get(`${GRAPH}/test/ordinary/:id`, async () => {
      activeOperations += 1;
      maximumOperations = Math.max(maximumOperations, activeOperations);
      await new Promise((resolve) => setTimeout(resolve, 15));
      activeOperations -= 1;
      return HttpResponse.json({ ok: true });
    }),
  );

  const clientProvider = await provider();
  const graph = new GraphClient(clientProvider as never, account.homeAccountId, {
    sleep: async (milliseconds) => {
      retryDelays.push(milliseconds);
    },
  });
  const batchPromise = executeBatch(graph, [
    { id: 'ordinary-1', method: 'GET', url: '/me/messages/one' },
    { id: 'throttled-item', method: 'GET', url: '/me/messages/two' },
    { id: 'ordinary-3', method: 'GET', url: '/me/messages/three' },
    { id: 'ordinary-4', method: 'GET', url: '/me/messages/four' },
  ]);
  const ordinaryPromises = [graph.get('/test/ordinary/1'), graph.get('/test/ordinary/2')];
  const [batchResults] = await Promise.all([batchPromise, Promise.all(ordinaryPromises)]);

  expect(batchCalls).toEqual([
    ['ordinary-1', 'throttled-item', 'ordinary-3', 'ordinary-4'],
    ['throttled-item'],
  ]);
  expect(retryDelays).toEqual([1_000]);
  expect(batchResults.every((result) => result.ok)).toBe(true);
  expect(maximumOperations).toBe(4);
  expect(maximumOperations).toBeLessThanOrEqual(4);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
