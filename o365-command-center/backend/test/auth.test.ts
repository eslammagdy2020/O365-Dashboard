import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/env.js';
import { loadConfig } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import type { MsalClientProvider } from '../src/auth/requireAuth.js';
import { SyncScheduler } from '../src/sync/scheduler.js';

const databases: Database.Database[] = [];
const accessToken = 'mocked-access-token-never-returned';

function setup() {
  const database = new Database(':memory:');
  databases.push(database);
  database.exec(
    readFileSync(
      fileURLToPath(new URL('../src/db/migrations/001_init.sql', import.meta.url)),
      'utf8',
    ),
  );
  const config = loadConfig({
    SESSION_SECRET: '0123456789abcdef0123456789abcdef',
    LOCALAPPDATA: 'C:\\test-data',
    DATA_DIR: 'C:\\test-data',
    CLIENT_ID: 'mock-client-id',
    TENANT_ID: 'mock-tenant-id',
    FRONTEND_URL: 'http://localhost:5173',
    REDIRECT_URI: 'http://localhost:5000/auth/callback',
  });
  const account = {
    homeAccountId: 'mock-home-account',
    localAccountId: 'mock-object-id',
    name: 'Mock User',
    environment: 'login.microsoftonline.com',
    tenantId: 'mock-tenant-id',
    username: 'mock@example.invalid',
  };
  const tokenCache = {
    getAccountByHomeId: vi.fn(async (id: string) =>
      id === account.homeAccountId ? account : null,
    ),
    removeAccount: vi.fn(async () => undefined),
  };
  const client = {
    getAuthCodeUrl: vi.fn(async (options: Record<string, string | string[]>) => {
      const authorizeUrl = new URL('https://login.microsoftonline.com/mock/oauth2/v2.0/authorize');
      for (const [key, value] of Object.entries(options)) {
        const queryKey =
          key === 'codeChallenge'
            ? 'code_challenge'
            : key === 'codeChallengeMethod'
              ? 'code_challenge_method'
              : key;
        if (key === 'scopes')
          authorizeUrl.searchParams.set('scope', Array.isArray(value) ? value.join(' ') : value);
        else
          authorizeUrl.searchParams.set(queryKey, Array.isArray(value) ? value.join(' ') : value);
      }
      return authorizeUrl.toString();
    }),
    acquireTokenByCode: vi.fn(async () => ({ account, accessToken })),
    getTokenCache: () => tokenCache,
    acquireTokenSilent: vi.fn(async () => ({ account, accessToken })),
  };
  const getClient = vi.fn(async () => client) as unknown as MsalClientProvider;
  return { database, config, account, tokenCache, client, getClient };
}

function appFor(config: AppConfig, database: Database.Database, getClient: MsalClientProvider) {
  return createApp(config, database, getClient);
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.spyOn(SyncScheduler.prototype, 'start').mockImplementation(() => undefined);
});

describe('T2 Entra sign-in and persistent sessions', () => {
  it('starts a PKCE login, consumes state once, regenerates the session, and never returns tokens', async () => {
    const { database, config, getClient } = setup();
    const agent = request.agent(appFor(config, database, getClient));
    const login = await agent.get('/auth/login').expect(302);
    const authorizeUrl = new URL(login.headers.location);
    const state = authorizeUrl.searchParams.get('state');

    expect(state).toBeTruthy();
    expect(authorizeUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl.searchParams.get('prompt')).toBe('select_account');
    expect(authorizeUrl.searchParams.get('scope')).toBe('User.Read Mail.Read');

    const callback = await agent
      .get(`/auth/callback?code=mock-code&state=${encodeURIComponent(state ?? '')}`)
      .expect(302);
    expect(callback.headers.location).toBe(config.FRONTEND_URL);
    expect(login.headers['set-cookie'][0]).toContain('SameSite=Lax');
    expect(callback.headers['set-cookie'][0].split(';')[0]).not.toBe(
      login.headers['set-cookie'][0].split(';')[0],
    );
    await agent
      .get(`/auth/callback?code=mock-code&state=${encodeURIComponent(state ?? '')}`)
      .expect(400);
    const me = await agent.get('/auth/me').expect(200);
    expect(me.body).toEqual({ data: { name: 'Mock User' } });
    expect(JSON.stringify(me.body)).not.toContain(accessToken);
    expect(
      database.prepare('SELECT value_json FROM settings WHERE key = ?').get('mailboxObjectId'),
    ).toEqual({
      value_json: JSON.stringify('mock-object-id'),
    });
  });

  it('starts background sync after a fresh sign-in without an explicit sync request', async () => {
    vi.mocked(SyncScheduler.prototype.start).mockRestore();
    vi.useFakeTimers();
    const { database, config, getClient } = setup();
    const app = appFor(config, database, getClient);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname === '/v1.0/me') {
        return new Response(JSON.stringify({ mail: 'mock@example.invalid' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname.startsWith('/v1.0/me/mailFolders/')) {
        if (url.pathname.endsWith('/messages/delta')) {
          return new Response(
            JSON.stringify({ value: [], '@odata.deltaLink': 'mock-delta-link' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        const name = url.pathname.split('/').at(-1) ?? 'folder';
        return new Response(JSON.stringify({ id: `mock-${name}`, displayName: name }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected mocked Graph request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const agent = request.agent(app);
      const login = await agent.get('/auth/login').expect(302);
      const state = new URL(login.headers.location).searchParams.get('state');
      await agent
        .get(`/auth/callback?code=mock-code&state=${encodeURIComponent(state ?? '')}`)
        .expect(302);

      const status = await agent.get('/api/sync/status').expect(200);
      expect(status.body.data.nextRunAt).toEqual(expect.any(String));
      expect(Number.isNaN(Date.parse(status.body.data.nextRunAt))).toBe(false);
    } finally {
      databases.splice(databases.indexOf(database), 1);
      await app.locals.shutdown();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('rejects a second mailbox without changing the configured mailbox', async () => {
    const { database, config, getClient } = setup();
    database
      .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)')
      .run('mailboxObjectId', JSON.stringify('different-object-id'));
    const agent = request.agent(appFor(config, database, getClient));
    const login = await agent.get('/auth/login').expect(302);
    const state = new URL(login.headers.location).searchParams.get('state');
    await agent
      .get(`/auth/callback?code=mock-code&state=${encodeURIComponent(state ?? '')}`)
      .expect(403);
    expect(
      database.prepare('SELECT value_json FROM settings WHERE key = ?').get('mailboxObjectId'),
    ).toEqual({
      value_json: JSON.stringify('different-object-id'),
    });
  });

  it('gates all API routes and enforces loopback host and mutation headers', async () => {
    const { database, config, getClient } = setup();
    const app = appFor(config, database, getClient);

    await request(app)
      .get('/api/not-implemented')
      .expect(401)
      .expect(({ body }) => {
        expect(body.error.code).toBe('login_required');
      });
    await request(app).get('/api/health').set('Host', 'evil.example').expect(403);
    await request(app)
      .post('/auth/logout')
      .set('Origin', config.FRONTEND_URL)
      .set('X-Requested-With', 'occ')
      .set('Host', 'evil.example')
      .expect(403);
    await request(app)
      .post('/auth/logout')
      .set('Origin', 'http://evil.example')
      .set('X-Requested-With', 'occ')
      .expect(403);
    await request(app).post('/auth/logout').set('Origin', config.FRONTEND_URL).expect(403);
    await request(app)
      .post('/auth/logout')
      .set('Origin', config.FRONTEND_URL)
      .set('X-Requested-With', 'occ')
      .expect(204);
  });

  it('keeps a session usable after rebuilding the app around the same database', async () => {
    const { database, config, getClient } = setup();
    const firstApp = appFor(config, database, getClient);
    const agent = request.agent(firstApp);
    const login = await agent.get('/auth/login').expect(302);
    const state = new URL(login.headers.location).searchParams.get('state');
    const callback = await agent
      .get(`/auth/callback?code=mock-code&state=${encodeURIComponent(state ?? '')}`)
      .expect(302);

    const restartedApp = appFor(config, database, getClient);
    await request(restartedApp)
      .get('/auth/me')
      .set('Cookie', login.headers['set-cookie'][0].split(';')[0])
      .expect(401);
    await request(restartedApp)
      .get('/auth/me')
      .set('Cookie', callback.headers['set-cookie'][0].split(';')[0])
      .expect(200);
    await request(restartedApp).get('/api/not-implemented').expect(401);
  });

  it('forwards a claims challenge to the next login and removes the cached account on logout', async () => {
    const { database, config, client, getClient } = setup();
    client.acquireTokenSilent.mockRejectedValueOnce(
      Object.assign(new Error('interaction_required'), {
        errorCode: 'interaction_required',
        claims: '{"access_token":{"polids":{"essential":true}}}',
      }),
    );
    const agent = request.agent(appFor(config, database, getClient));
    const login = await agent.get('/auth/login').expect(302);
    const state = new URL(login.headers.location).searchParams.get('state');
    await agent
      .get(`/auth/callback?code=mock-code&state=${encodeURIComponent(state ?? '')}`)
      .expect(302);
    const unauthorized = await agent.get('/api/not-implemented').expect(401);
    expect(unauthorized.body.error.claims).toBeTruthy();
    const nextLogin = await agent.get('/auth/login').expect(302);
    expect(new URL(nextLogin.headers.location).searchParams.get('claims')).toBeTruthy();
    await agent
      .post('/auth/logout')
      .set('Origin', config.FRONTEND_URL)
      .set('X-Requested-With', 'occ')
      .expect(204);
    expect(client.getTokenCache().removeAccount).toHaveBeenCalledTimes(1);
  });
});
