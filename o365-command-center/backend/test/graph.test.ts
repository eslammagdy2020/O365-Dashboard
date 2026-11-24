import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PublicClientApplication } from '@azure/msal-node';
import { createApp } from '../src/app.js';
import { assertReadOnlyRequest, GraphClient, GraphError } from '../src/graph/graphClient.js';
import { executeBatch } from '../src/graph/batch.js';
import { createMailApi, MESSAGE_SELECT } from '../src/graph/mailApi.js';
import type { MsalClientProvider } from '../src/auth/requireAuth.js';
import type { AppConfig } from '../src/config/env.js';
import { loadConfig } from '../src/config/env.js';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

const base = 'https://graph.microsoft.com/v1.0';
const server = setupServer();
const waits: number[] = [];

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => {
  server.resetHandlers();
  waits.length = 0;
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function makeClient(fetcher?: typeof fetch) {
  const account = { homeAccountId: 'home-id' };
  const msal = {
    getTokenCache: () => ({ getAccountByHomeId: vi.fn(async () => account) }),
    acquireTokenSilent: vi.fn(async () => ({ accessToken: 'access-token' })),
  } as unknown as PublicClientApplication;
  const client = new GraphClient(msal, 'home-id', {
    timeoutMs: 5_000,
    ...(fetcher ? { fetcher } : {}),
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
    },
    random: () => 0.5,
  });
  return { client, msal };
}

describe('Graph read client and folders API', () => {
  it('allows a GET request, including an omitted method', () => {
    expect(() => assertReadOnlyRequest('/me', { method: 'GET' })).not.toThrow();
    expect(() => assertReadOnlyRequest('/me', {})).not.toThrow();
  });

  it('allows a batch POST containing only GET requests, including an omitted method', () => {
    expect(() =>
      assertReadOnlyRequest('/$batch', {
        method: 'POST',
        body: JSON.stringify({ requests: [{ method: 'GET' }, { url: '/me' }] }),
      }),
    ).not.toThrow();
  });

  it('rejects a batch POST containing a non-GET request', () => {
    expect(() =>
      assertReadOnlyRequest('/$batch', {
        method: 'POST',
        body: JSON.stringify({ requests: [{ method: 'GET' }, { method: 'PATCH' }] }),
      }),
    ).toThrow(expect.objectContaining({ status: 400, code: 'forbidden' }));
  });

  it('rejects direct non-GET methods', () => {
    expect(() => assertReadOnlyRequest('/me/messages/1', { method: 'DELETE' })).toThrow(
      expect.objectContaining({ status: 400, code: 'forbidden' }),
    );
  });

  it('rejects a forbidden request before token acquisition or fetch', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { client, msal } = makeClient(fetcher);

    await expect(
      client.batchPost({ requests: [{ method: 'PATCH' }] }, 1),
    ).rejects.toMatchObject({ status: 400, code: 'forbidden' });
    expect(msal.acquireTokenSilent).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends delegated bearer headers and retries 429 using Retry-After', async () => {
    const { client } = makeClient();
    let calls = 0;
    server.use(
      http.get(`${base}/me`, ({ request }) => {
        calls += 1;
        expect(request.headers.get('authorization')).toBe('Bearer access-token');
        expect(request.headers.get('prefer')).toBe('IdType="ImmutableId"');
        expect(request.headers.get('client-request-id')).toBeTruthy();
        if (calls === 1)
          return HttpResponse.json(
            { error: { code: 'TooManyRequests' } },
            { status: 429, headers: { 'retry-after': '3' } },
          );
        return HttpResponse.json({ id: 'me' });
      }),
    );

    await expect(client.get('/me')).resolves.toEqual({ id: 'me' });
    expect(calls).toBe(2);
    expect(waits).toEqual([3_000]);
  });

  it('backs off after a 503 and throws typed errors for other 4xx', async () => {
    const { client } = makeClient();
    let calls = 0;
    server.use(
      http.get(`${base}/retry`, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ error: { code: 'ServiceUnavailable' } }, { status: 503 })
          : HttpResponse.json({ value: true });
      }),
      http.get(`${base}/bad`, () =>
        HttpResponse.json(
          { error: { code: 'InvalidRequest', message: 'Nope', requestId: 'rid' } },
          { status: 400 },
        ),
      ),
    );

    await expect(client.get('/retry')).resolves.toEqual({ value: true });
    expect(waits).toEqual([1_000]);
    await expect(client.get('/bad')).rejects.toMatchObject<Partial<GraphError>>({
      status: 400,
      code: 'InvalidRequest',
      requestId: 'rid',
    });
  });

  it('forces one silent token refresh after 401 and marks second 401 login_required', async () => {
    const { client, msal } = makeClient();
    let calls = 0;
    vi.mocked(msal.acquireTokenSilent).mockResolvedValue({
      accessToken: 'refreshed-token',
    } as never);
    server.use(
      http.get(`${base}/refresh`, ({ request }) => {
        calls += 1;
        if (calls === 1) return HttpResponse.json({}, { status: 401 });
        expect(request.headers.get('authorization')).toBe('Bearer refreshed-token');
        return HttpResponse.json({ ok: true });
      }),
    );
    await expect(client.get('/refresh')).resolves.toEqual({ ok: true });
    expect(msal.acquireTokenSilent).toHaveBeenCalledTimes(2);
    expect(msal.acquireTokenSilent).toHaveBeenLastCalledWith(
      expect.objectContaining({ forceRefresh: true }),
    );

    server.use(
      http.get(`${base}/still-unauthorized`, () => HttpResponse.json({}, { status: 401 })),
    );
    await expect(client.get('/still-unauthorized')).rejects.toMatchObject({
      status: 401,
      code: 'login_required',
    });
  });

  it('follows next links verbatim and returns the final delta link without logging it', async () => {
    const { client } = makeClient();
    const opaqueNext = `${base}/me/mailFolders?$skiptoken=A%2FB&opaque=unchanged`;
    const opaqueDelta = `${base}/delta?token=private-value`;
    const requested: string[] = [];
    server.use(
      http.get(`${base}/me/mailFolders`, ({ request }) => {
        requested.push(request.url);
        if (new URL(request.url).searchParams.has('$skiptoken')) {
          return HttpResponse.json({ value: [{ id: 'folder-2' }] });
        }
        return HttpResponse.json({ value: [{ id: 'folder-1' }], '@odata.nextLink': opaqueNext });
      }),
      http.get(`${base}/me/mailFolders/folder-1/messages/delta`, () =>
        HttpResponse.json({
          value: [{ id: 'message-1' }],
          '@odata.deltaLink': opaqueDelta,
        }),
      ),
    );

    const api = createMailApi({} as unknown as PublicClientApplication, 'home-id');
    (api as unknown as { client: GraphClient }).client = client;
    await expect(api.listFolders()).resolves.toEqual([{ id: 'folder-1' }, { id: 'folder-2' }]);
    expect(requested[1]).toBe(opaqueNext);
    await expect(api.messagesDelta('folder-1', null)).resolves.toEqual({
      value: [{ id: 'message-1' }],
      '@odata.deltaLink': opaqueDelta,
    });
  });

  it('yields each delta page with opaque links and adds max page size without dropping ImmutableId', async () => {
    const { client } = makeClient();
    const opaqueNext = `${base}/delta?skiptoken=opaque%2Fvalue`;
    const opaqueDelta = `${base}/delta?deltatoken=opaque-value`;
    const requested: string[] = [];
    server.use(
      http.get(`${base}/me/mailFolders/folder-1/messages/delta`, ({ request }) => {
        requested.push(request.url);
        expect(request.headers.get('prefer')).toContain('odata.maxpagesize=50');
        expect(request.headers.get('prefer')).toContain('IdType="ImmutableId"');
        expect(request.headers.get('authorization')).toBe('Bearer access-token');
        expect(request.headers.get('client-request-id')).toBeTruthy();
        return HttpResponse.json({
          value: [{ id: 'message-1' }],
          '@odata.nextLink': opaqueNext,
        });
      }),
      http.get(`${base}/delta`, ({ request }) => {
        requested.push(request.url);
        expect(request.headers.get('prefer')).toContain('odata.maxpagesize=50');
        expect(request.headers.get('prefer')).toContain('IdType="ImmutableId"');
        expect(request.headers.get('authorization')).toBe('Bearer access-token');
        expect(request.headers.get('client-request-id')).toBeTruthy();
        return HttpResponse.json({ value: [{ id: 'message-2' }], '@odata.deltaLink': opaqueDelta });
      }),
    );

    const api = createMailApi({} as unknown as PublicClientApplication, 'home-id');
    (api as unknown as { client: GraphClient }).client = client;
    const pages = [];
    for await (const page of api.messagesDeltaPages('folder-1', null)) pages.push(page);

    expect(pages).toEqual([
      { value: [{ id: 'message-1' }], '@odata.nextLink': opaqueNext },
      { value: [{ id: 'message-2' }], '@odata.deltaLink': opaqueDelta },
    ]);
    expect(new URL(requested[0]).searchParams.get('$select')).toBe(MESSAGE_SELECT);
    expect(new URL(requested[0]).searchParams.has('$filter')).toBe(false);
    expect(requested[1]).toBe(opaqueNext);
  });

  it('accounts each batch inner request against the global limiter and delays only throttled item retries', async () => {
    const { client } = makeClient();
    let active = 0;
    let maximum = 0;
    const counts = new Map<string, number>();
    server.use(
      http.post(`${base}/$batch`, async ({ request }) => {
        const payload = (await request.json()) as {
          requests: Array<{ id: string; headers: Record<string, string> }>;
        };
        active += payload.requests.length;
        maximum = Math.max(maximum, active);
        expect(
          payload.requests.every((item) => item.headers.Prefer === 'IdType="ImmutableId"'),
        ).toBe(true);
        const responses = payload.requests.map(({ id }) => {
          const count = (counts.get(id) ?? 0) + 1;
          counts.set(id, count);
          return id === 'a' && count === 1
            ? { id, status: 429, headers: { 'Retry-After': '7' } }
            : { id, status: 200, body: { id } };
        });
        active -= payload.requests.length;
        return HttpResponse.json({ responses });
      }),
    );

    const results = await executeBatch(client, [
      { id: 'a', method: 'GET', url: '/me/messages/a' },
      { id: 'b', method: 'GET', url: '/me/messages/b' },
      { id: 'c', method: 'GET', url: '/me/messages/c' },
      { id: 'd', method: 'GET', url: '/me/messages/d' },
      { id: 'e', method: 'GET', url: '/me/messages/e' },
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(maximum).toBeLessThanOrEqual(4);
    expect(waits).toContain(7_000);
    expect(counts.get('a')).toBe(2);
    expect(counts.get('b')).toBe(1);
  });

  it('returns folders in the data envelope with well-known identification', async () => {
    const database = new Database(':memory:');
    database.exec(
      readFileSync(
        fileURLToPath(new URL('../src/db/migrations/001_init.sql', import.meta.url)),
        'utf8',
      ),
    );
    const config: AppConfig = loadConfig({
      SESSION_SECRET: '0123456789abcdef0123456789abcdef',
      LOCALAPPDATA: 'C:\\test-data',
      DATA_DIR: 'C:\\test-data',
      FRONTEND_URL: 'http://localhost:5173',
    });
    const account = { homeAccountId: 'home-id' };
    const client = {
      getAuthCodeUrl: vi.fn(async (options: { state: string }) => {
        const url = new URL('https://login.example/authorize');
        url.searchParams.set('state', options.state);
        return url.toString();
      }),
      acquireTokenByCode: vi.fn(async () => ({
        account: {
          homeAccountId: 'home-id',
          localAccountId: 'object-id',
          environment: 'login.microsoftonline.com',
          tenantId: 'tenant-id',
          username: 'user@example.invalid',
        },
        accessToken: 'access-token',
      })),
      getTokenCache: () => ({ getAccountByHomeId: vi.fn(async () => account) }),
      acquireTokenSilent: vi.fn(async () => ({ accessToken: 'access-token' })),
    } as unknown as PublicClientApplication;
    const provider = vi.fn(async () => client) as unknown as MsalClientProvider;
    server.use(
      http.get(`${base}/me/mailFolders`, () =>
        HttpResponse.json({ value: [{ id: 'inbox-id', displayName: 'Inbox' }] }),
      ),
      http.get(`${base}/me/mailFolders/inbox`, () =>
        HttpResponse.json({ id: 'inbox-id', displayName: 'Inbox' }),
      ),
      http.get(`${base}/me/mailFolders/sentitems`, () => HttpResponse.json({ id: 'sent-id' })),
      http.get(`${base}/me/mailFolders/archive`, () => HttpResponse.json({ id: 'archive-id' })),
      http.get(`${base}/me/mailFolders/deleteditems`, () =>
        HttpResponse.json({ id: 'deleted-id' }),
      ),
    );

    const app = createApp(config, database, provider);
    const agent = request.agent(app);
    const login = await agent.get('/auth/login').expect(302);
    const state = new URL(login.headers.location).searchParams.get('state');
    await agent
      .get(`/auth/callback?code=mock-code&state=${encodeURIComponent(state ?? '')}`)
      .expect(302);
    const response = await agent.get('/api/folders').expect(200);
    expect(response.body).toEqual({
      data: [{ id: 'inbox-id', displayName: 'Inbox', wellKnown: 'inbox' }],
    });
    database.close();
  });
});
