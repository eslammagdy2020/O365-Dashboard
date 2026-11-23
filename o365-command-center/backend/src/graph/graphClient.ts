import { randomUUID } from 'node:crypto';
import type { PublicClientApplication } from '@azure/msal-node';
import type { GraphErrorBody } from './types.js';

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const MAX_CONCURRENCY = 4;
const MAX_CONCURRENT_BATCHES = 2;
const RETRY_STATUSES = new Set([429, 503, 504]);
const SCOPES = ['User.Read', 'Mail.ReadWrite'];

type Waiter = { count: number; resolve: () => void };

class SlotLimiter {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  async acquire(count = 1): Promise<() => void> {
    const slots = Math.min(MAX_CONCURRENCY, Math.max(1, count));
    if (this.active + slots > MAX_CONCURRENCY || this.waiters.length > 0) {
      await new Promise<void>((resolve) => this.waiters.push({ count: slots, resolve }));
    } else {
      this.active += slots;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= slots;
      this.drain();
    };
  }

  private drain(): void {
    while (this.waiters[0] && this.active + this.waiters[0].count <= MAX_CONCURRENCY) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      this.active += waiter.count;
      waiter.resolve();
    }
  }
}

class BatchLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (this.active >= MAX_CONCURRENT_BATCHES) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) {
        this.active += 1;
        next();
      }
    };
  }
}

const operationLimiter = new SlotLimiter();
const batchLimiter = new BatchLimiter();
const inFlightControllers = new Set<AbortController>();
const activeTimeouts = new Set<ReturnType<typeof setTimeout>>();

export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
    message = 'Microsoft Graph request failed',
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

export type GraphClientOptions = {
  timeoutMs?: number;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
};

export class GraphClient {
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;

  constructor(
    private readonly client: PublicClientApplication,
    private readonly homeAccountId: string,
    options: GraphClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? (Number(process.env.GRAPH_TIMEOUT_MS) || 30_000);
    this.fetcher = options.fetcher ?? fetch;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
  }

  async get<T>(url: string, signal?: AbortSignal, headers?: HeadersInit): Promise<T> {
    return this.request<T>(url, { method: 'GET', signal, headers });
  }

  async batchPost<T>(body: unknown, operationCount: number): Promise<T> {
    const releaseBatch = await batchLimiter.acquire();
    try {
      return await this.request<T>(
        '/$batch',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        false,
        Math.min(operationCount, MAX_CONCURRENCY),
      );
    } finally {
      releaseBatch();
    }
  }

  async batchRetryAfter(milliseconds: number): Promise<void> {
    await this.sleep(milliseconds);
  }

  private async request<T>(
    url: string,
    init: RequestInit,
    acquireSlot = true,
    slotCount = 1,
  ): Promise<T> {
    let forceRefresh = false;
    let refreshed = false;
    let attempt = 0;
    while (true) {
      const accessToken = await this.acquireToken(forceRefresh);
      forceRefresh = false;
      const releaseSlot = await operationLimiter.acquire(acquireSlot ? 1 : slotCount);
      const controller = new AbortController();
      inFlightControllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      activeTimeouts.add(timeout);
      const externalSignal = init.signal;
      const abortFromCaller = () => controller.abort();
      if (externalSignal?.aborted) controller.abort();
      else externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
      let retryDelay: number | undefined;
      try {
        const headers = new Headers(init.headers);
        headers.set('authorization', `Bearer ${accessToken}`);
        const requestedPrefer = headers.get('prefer');
        headers.set(
          'prefer',
          requestedPrefer
            ? `${requestedPrefer}, IdType="ImmutableId"`
            : 'IdType="ImmutableId"',
        );
        headers.set('client-request-id', randomUUID());
        const response = await this.fetcher(resolveGraphUrl(url), {
          ...init,
          headers,
          signal: controller.signal,
        });
        if (response.status === 401) {
          if (!refreshed) {
            refreshed = true;
            forceRefresh = true;
            continue;
          }
          const authError = await graphError(response, true);
          throw new GraphError(401, 'login_required', authError.requestId, 'Sign in is required');
        }
        if (RETRY_STATUSES.has(response.status)) {
          if (attempt >= 5) throw await graphError(response);
          retryDelay =
            parseRetryAfter(response.headers.get('retry-after')) ??
            exponentialDelay(attempt, this.random);
          attempt += 1;
        } else {
          if (!response.ok) throw await graphError(response);
          if (response.status === 204) return undefined as T;
          return (await response.json()) as T;
        }
      } catch (error) {
        if (error instanceof GraphError) throw error;
        if (controller.signal.aborted) {
          throw new GraphError(
            408,
            'timeout',
            undefined,
            'Microsoft Graph request timed out or was aborted',
          );
        }
        throw new GraphError(
          503,
          'network_error',
          undefined,
          'Microsoft Graph could not be reached',
        );
      } finally {
        clearTimeout(timeout);
        activeTimeouts.delete(timeout);
        externalSignal?.removeEventListener('abort', abortFromCaller);
        inFlightControllers.delete(controller);
        releaseSlot();
      }
      if (retryDelay !== undefined) await this.sleep(retryDelay);
    }
  }

  private async acquireToken(forceRefresh: boolean): Promise<string> {
    try {
      const account = await this.client.getTokenCache().getAccountByHomeId(this.homeAccountId);
      if (!account) throw new Error('interaction_required');
      const result = await this.client.acquireTokenSilent({
        account,
        scopes: SCOPES,
        ...(forceRefresh ? { forceRefresh: true } : {}),
      });
      return result.accessToken;
    } catch {
      throw new GraphError(401, 'login_required', undefined, 'Sign in is required');
    }
  }
}

export function abortAllGraphRequests(): void {
  for (const controller of inFlightControllers) controller.abort();
  for (const timeout of activeTimeouts) clearTimeout(timeout);
  activeTimeouts.clear();
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function exponentialDelay(attempt: number, random: () => number): number {
  const base = 1_000 * 2 ** attempt;
  return Math.round(base * (0.5 + random()));
}

function resolveGraphUrl(url: string): string {
  if (/^https:\/\//i.test(url)) return url;
  const path = url.startsWith('/') ? url : `/${url}`;
  return `${GRAPH_BASE_URL}${path}`;
}

async function graphError(response: Response, loginRequired = false): Promise<GraphError> {
  let body: GraphErrorBody | undefined;
  try {
    body = (await response.clone().json()) as GraphErrorBody;
  } catch {
    body = undefined;
  }
  const code = loginRequired ? 'login_required' : (body?.error?.code ?? `http_${response.status}`);
  const requestId = body?.error?.requestId ?? response.headers.get('request-id') ?? undefined;
  return new GraphError(
    loginRequired ? 401 : response.status,
    code,
    requestId,
    loginRequired
      ? 'Sign in is required'
      : (body?.error?.message ?? 'Microsoft Graph request failed'),
  );
}
