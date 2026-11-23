import { GraphClient, parseRetryAfter } from './graphClient.js';
import type { GraphBatchResponse, GraphBatchSubResponse } from './types.js';

export type BatchRequest = {
  id: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
};

export type BatchItemResult =
  | { id: string; ok: true; status: number; headers?: Record<string, string>; body?: unknown }
  | { id: string; ok: false; status: number; code: string; requestId?: string; body?: unknown };

const MAX_REQUESTS_PER_BATCH = 20;
const MAX_INNER_REQUESTS_PER_CALL = 4;
const MAX_PASSES = 3;

export async function executeBatch(
  client: GraphClient,
  requests: BatchRequest[],
): Promise<BatchItemResult[]> {
  if (requests.length > MAX_REQUESTS_PER_BATCH) {
    throw new RangeError('A Graph batch cannot contain more than 20 sub-requests');
  }
  const seen = new Set<string>();
  for (const request of requests) {
    if (seen.has(request.id)) throw new Error('Graph batch request ids must be unique');
    seen.add(request.id);
  }

  const results = new Map<string, BatchItemResult>();
  let pending: Array<{ request: BatchRequest; pass: number; delay?: number }> = requests.map(
    (request) => ({
      request,
      pass: 1,
    }),
  );

  while (pending.length > 0) {
    const current = pending;
    const retry: Array<{ request: BatchRequest; pass: number; delay?: number }> = [];
    const ready = current.filter((entry) => entry.delay === undefined);
    const delayed = current.filter((entry) => entry.delay !== undefined);
    const responsePromises = chunk(ready, MAX_INNER_REQUESTS_PER_CALL).map(async (items) => {
      const response = await client.batchPost<GraphBatchResponse>(
        {
          requests: items.map(({ request }) => ({
            ...request,
            headers: { ...request.headers, Prefer: 'IdType="ImmutableId"' },
          })),
        },
        items.length,
      );
      return { items, response };
    });
    const delayedPromises = delayed.map(async ({ request, pass, delay }) => {
      if (delay !== undefined) await client.batchRetryAfter(delay);
      const response = await client.batchPost<GraphBatchResponse>(
        {
          requests: [
            {
              ...request,
              headers: { ...request.headers, Prefer: 'IdType="ImmutableId"' },
            },
          ],
        },
        1,
      );
      return {
        request,
        pass,
        subResponse: response.responses.find((entry) => entry.id === request.id),
      };
    });
    const [readyResponses, delayedResponses] = await Promise.all([
      Promise.all(responsePromises),
      Promise.all(delayedPromises),
    ]);
    for (const { items, response } of readyResponses) {
      const byId = new Map(response.responses.map((entry) => [entry.id, entry]));
      for (const { request, pass } of items) {
        const subResponse = byId.get(request.id);
        addResponse(request, pass, subResponse, retry, results);
      }
    }
    for (const { request, pass, subResponse } of delayedResponses) {
      addResponse(request, pass, subResponse, retry, results);
    }
    pending = retry;
  }

  return requests.map(
    (request) =>
      results.get(request.id) ?? {
        id: request.id,
        ok: false,
        status: 502,
        code: 'missing_batch_response',
      },
  );
}

function addResponse(
  request: BatchRequest,
  pass: number,
  response: GraphBatchSubResponse | undefined,
  retry: Array<{ request: BatchRequest; pass: number; delay?: number }>,
  results: Map<string, BatchItemResult>,
): void {
  if (!response) {
    results.set(request.id, {
      id: request.id,
      ok: false,
      status: 502,
      code: 'missing_batch_response',
    });
  } else if (isRetryable(response.status) && pass < MAX_PASSES) {
    const delay = parseRetryAfter(getHeader(response.headers, 'retry-after'));
    retry.push({ request, pass: pass + 1, ...(delay === undefined ? {} : { delay }) });
  } else {
    results.set(request.id, itemResult(response));
  }
}

function itemResult(response: GraphBatchSubResponse): BatchItemResult {
  if (response.status >= 200 && response.status < 300) {
    return {
      id: response.id,
      ok: true,
      status: response.status,
      ...(response.headers ? { headers: response.headers } : {}),
      ...(response.body === undefined ? {} : { body: response.body }),
    };
  }
  const body = response.body as { error?: { code?: string; requestId?: string } } | undefined;
  return {
    id: response.id,
    ok: false,
    status: response.status,
    code: body?.error?.code ?? `http_${response.status}`,
    ...(body?.error?.requestId ? { requestId: body.error.requestId } : {}),
    ...(response.body === undefined ? {} : { body: response.body }),
  };
}

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function getHeader(headers: Record<string, string> | undefined, name: string): string | null {
  if (!headers) return null;
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size)
    chunks.push(items.slice(offset, offset + size));
  return chunks;
}
