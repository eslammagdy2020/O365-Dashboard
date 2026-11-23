import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/env.js';
import { loadConfig } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import type { MsalClientProvider } from '../src/auth/requireAuth.js';
import { applyDeltaPage } from '../src/sync/deltaApplier.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const server = setupServer();
const databases: Database.Database[] = [];
const opaqueNext = `${GRAPH}/delta?opaque=next-token`;
let releaseSecondPage: (() => void) | undefined;

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  releaseSecondPage?.();
  releaseSecondPage = undefined;
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
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

function setupApp(database: Database.Database, clientProvider: MsalClientProvider) {
  const config: AppConfig = loadConfig({
    SESSION_SECRET: '0123456789abcdef0123456789abcdef',
    DATA_DIR: 'C:\\test-data',
    LOCALAPPDATA: 'C:\\test-data',
    FRONTEND_URL: 'http://localhost:5173',
  });
  return { app: createApp(config, database, clientProvider), config };
}

async function signIn(app: ReturnType<typeof createApp>) {
  const agent = request.agent(app);
  const login = await agent.get('/auth/login').expect(302);
  const state = new URL(login.headers.location).searchParams.get('state');
  await agent
    .get(`/auth/callback?code=mock-code&state=${encodeURIComponent(state ?? '')}`)
    .expect(302);
  return agent;
}

const message = (id: string, values: Record<string, unknown> = {}) => ({
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
  ...values,
});

describe('inbox delta applier', () => {
  it('upserts inbound and from-me rows with the correct effective date and null scores', () => {
    const database = createDatabase();
    applyDeltaPage(
      database,
      'inbox-id',
      [
        message('inbound'),
        message('outbound', {
          from: { emailAddress: { address: 'ME@example.invalid', name: 'Me' } },
          receivedDateTime: '2026-11-20T10:00:00Z',
          sentDateTime: '2026-11-21T10:00:00Z',
        }),
      ],
      { deltaLink: `${GRAPH}/delta?opaque=done`, windowDays: 90 },
      ['me@example.invalid'],
    );
    expect(
      database
        .prepare(
          'SELECT id, is_from_me, received_at, effective_at, base_score, score, score_breakdown_json, auto_categories_json FROM messages ORDER BY id',
        )
        .all(),
    ).toEqual([
      {
        id: 'inbound',
        is_from_me: 0,
        received_at: '2026-11-22T10:00:00.000Z',
        effective_at: '2026-11-22T10:00:00.000Z',
        base_score: null,
        score: null,
        score_breakdown_json: null,
        auto_categories_json: null,
      },
      {
        id: 'outbound',
        is_from_me: 1,
        received_at: '2026-11-20T10:00:00.000Z',
        effective_at: '2026-11-21T10:00:00.000Z',
        base_score: null,
        score: null,
        score_breakdown_json: null,
        auto_categories_json: null,
      },
    ]);
  });

  it('applies the local window and persists the opaque continuation with each page', () => {
    const database = createDatabase();
    const next = `${GRAPH}/delta?opaque=resume`;
    applyDeltaPage(
      database,
      'inbox-id',
      [message('inside'), message('outside', { receivedDateTime: '2020-01-01T00:00:00Z' })],
      { nextLink: next, windowDays: 90 },
      ['me@example.invalid'],
    );
    expect(database.prepare('SELECT id FROM messages').all()).toEqual([{ id: 'inside' }]);
    expect(
      database.prepare('SELECT resume_link, delta_link, status FROM sync_state').get(),
    ).toEqual({
      resume_link: next,
      delta_link: null,
      status: 'syncing',
    });
    applyDeltaPage(
      database,
      'inbox-id',
      [],
      { deltaLink: `${GRAPH}/delta?opaque=final`, windowDays: 90 },
      [],
    );
    expect(
      database.prepare('SELECT resume_link, delta_link, status FROM sync_state').get(),
    ).toEqual({
      resume_link: null,
      delta_link: `${GRAPH}/delta?opaque=final`,
      status: 'idle',
    });
  });

  it('converges on Archive-added-first, Inbox-removal-first, and duplicate replays', () => {
    const run = (archiveFirst: boolean, replay: boolean) => {
      const database = createDatabase();
      applyDeltaPage(
        database,
        'inbox-id',
        [message('move-me')],
        { deltaLink: 'inbox-token', windowDays: 90 },
        [],
      );
      const addToArchive = () =>
        applyDeltaPage(
          database,
          'archive-id',
          [{ id: 'move-me', parentFolderId: 'archive-id' }],
          { deltaLink: 'archive-token', windowDays: 90 },
          [],
        );
      const removeFromInbox = () =>
        applyDeltaPage(
          database,
          'inbox-id',
          [{ id: 'move-me', '@removed': { reason: 'deleted' } }],
          { deltaLink: 'inbox-token-2', windowDays: 90 },
          [],
        );
      if (archiveFirst) {
        addToArchive();
        if (replay) addToArchive();
        removeFromInbox();
        if (replay) removeFromInbox();
      } else {
        removeFromInbox();
        if (replay) removeFromInbox();
        addToArchive();
        if (replay) addToArchive();
      }
      const result = database.prepare('SELECT id, folder_id, subject FROM messages').all();
      return result;
    };
    expect(run(false, false)).toEqual([
      { id: 'move-me', folder_id: 'archive-id', subject: 'Subject move-me' },
    ]);
    expect(run(false, true)).toEqual(run(false, false));
    expect(run(true, false)).toEqual(run(false, false));
    expect(run(true, true)).toEqual(run(false, false));
  });
});

describe('sync inbox HTTP flow', () => {
  it('exposes progress during a multi-page sync and returns the paged MessageRow list shape', async () => {
    const database = createDatabase();
    database
      .prepare(
        "INSERT INTO folders (id, display_name, well_known) VALUES ('inbox-id', 'Inbox', 'inbox')",
      )
      .run();
    let finishPageTwo: (() => void) | undefined;
    const secondPageGate = new Promise<void>((resolve) => {
      finishPageTwo = resolve;
    });
    releaseSecondPage = () => finishPageTwo?.();
    const account = {
      homeAccountId: 'home-id',
      localAccountId: 'object-id',
      environment: 'login.microsoftonline.com',
      tenantId: 'tenant-id',
      username: 'me@example.invalid',
    };
    const client = {
      getAuthCodeUrl: vi.fn(async (options: { state: string }) => {
        const url = new URL('https://login.example/authorize');
        url.searchParams.set('state', options.state);
        return url.toString();
      }),
      acquireTokenByCode: vi.fn(async () => ({ account, accessToken: 'mock-access-token' })),
      getTokenCache: () => ({ getAccountByHomeId: vi.fn(async () => account) }),
      acquireTokenSilent: vi.fn(async () => ({ account, accessToken: 'mock-access-token' })),
    };
    const provider = vi.fn(async () => client) as unknown as MsalClientProvider;
    const graphPaths: string[] = [];
    server.use(
      http.get(`${GRAPH}/me/mailFolders/inbox`, ({ request }) => {
        graphPaths.push(new URL(request.url).pathname);
        return HttpResponse.json({ id: 'inbox-id', displayName: 'Inbox' });
      }),
      http.get(`${GRAPH}/me`, ({ request }) => {
        graphPaths.push(new URL(request.url).pathname);
        return HttpResponse.json({ id: 'object-id', mail: 'me@example.invalid' });
      }),
      http.get(`${GRAPH}/me/mailFolders/inbox-id/messages/delta`, ({ request }) => {
        graphPaths.push(new URL(request.url).pathname);
        return HttpResponse.json({ value: [message('first-page')], '@odata.nextLink': opaqueNext });
      }),
      http.get(`${GRAPH}/delta`, async () => {
        await secondPageGate;
        return HttpResponse.json({
          value: [message('second-page', { receivedDateTime: '2026-11-23T10:00:00Z' })],
          '@odata.deltaLink': `${GRAPH}/delta?opaque=final`,
        });
      }),
    );
    const { app } = setupApp(database, provider);
    const agent = await signIn(app);
    await agent
      .post('/api/sync/run')
      .set('Origin', 'http://localhost:5173')
      .set('X-Requested-With', 'occ')
      .expect(202);
    let progress = await agent.get('/api/sync/status').expect(200);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (progress.body.data.counts.cached === 1 || progress.body.data.phase === 'error') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
      progress = await agent.get('/api/sync/status').expect(200);
    }
    expect(
      progress.body.data.phase,
      `${progress.body.data.lastError ?? ''} ${graphPaths.join(',')}`,
    ).toBe('syncing');
    expect(progress.body.data.counts).toMatchObject({ processed: 1, cached: 1 });
    expect(
      database.prepare('SELECT resume_link FROM sync_state WHERE folder_id = ?').get('inbox-id'),
    ).toEqual({
      resume_link: opaqueNext,
    });
    finishPageTwo?.();

    let status: { body: { data: { phase: string } } } | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      status = await agent.get('/api/sync/status');
      if (status.body.data.phase === 'idle') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(status?.body.data.phase).toBe('idle');
    const list = await agent
      .get('/api/messages?view=inbox&offset=0&limit=1&sort=receivedAt&order=desc')
      .expect(200);
    expect(list.body).toMatchObject({ total: 2, offset: 0, limit: 1 });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toEqual(
      expect.objectContaining({
        id: 'second-page',
        folderId: 'inbox-id',
        subject: 'Subject second-page',
        fromName: 'Sender',
        fromAddress: 'sender@example.invalid',
        baseScore: null,
        score: null,
        tier: null,
      }),
    );
  });
});
