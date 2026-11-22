# T3: Resilient Graph read client & folders API

**Status:** ready-for-agent

**Goal:** One dependable read path into Microsoft Graph, with throttling, token refresh, timeouts and batch accounting handled once, plus a working `GET /api/folders` that proves the path end to end. This is a prefactor: sync and the detail drawer both ride on it.

**Depends on:** T2 (needs a signed-in account and silent token acquisition).

**Allowed files** (paths relative to `o365-command-center/`):
- `backend/src/graph/graphClient.ts`, `batch.ts`, `mailApi.ts`
- `backend/src/routes/folderRoutes.ts`, `backend/src/controllers/folderController.ts`
- `backend/src/app.ts` (register folders router — shared file; run sequentially with other tickets that list it)
- `backend/test/graph.test.ts`

**Non-goals:**
- No mailbox writes, no sync engine, no database writes.
- Do not edit frozen `backend/src/graph/types.ts` or schema/migrations; import the frozen types.
- No live Graph calls in tests — msw only. Never log `nextLink` or `deltaLink`.

**What to build (user-visible):** `GET /api/folders` returns the signed-in user's folders as `{ data: [...] }`, including well-known folder identification. Failures surface as typed errors, not silent hangs.

**Acceptance criteria / test cases:**
- `graphClient.ts` wraps built-in `fetch` against `https://graph.microsoft.com/v1.0`, sending `Authorization: Bearer`, `Prefer: IdType="ImmutableId"` and a `client-request-id` on every request. Scope list is `User.Read` and `Mail.ReadWrite`.
- Retries: on 429/503/504 honour `Retry-After`, otherwise exponential backoff with jitter (1s, 2s, 4s …) up to 6 attempts. On 401 call `acquireTokenSilent({ forceRefresh: true })` once and retry once; on a second failure mark `login_required`. Other 4xx throw `GraphError(status, code, requestId)` with no retry. Typed error shape comes from the frozen contract.
- Every request has an `AbortController` timeout (`GRAPH_TIMEOUT_MS`, default 30s). Shutdown or purge aborts all in-flight requests.
- Global concurrency limiter of 4. Appendix A2: each `$batch` inner request consumes a slot, batches share the limiter with ordinary calls, at most 20 sub-requests per batch and at most 2 concurrent batch calls.
- `batch.ts` parses every sub-response status individually, retries only items with 429 or 5xx, at most 3 passes per batch, and reports still-failing items per item. Each sub-request carries its own `Prefer: IdType="ImmutableId"` header. `Retry-After` from a throttled sub-response delays only that item's retry.
- Paging helper follows `@odata.nextLink` until `@odata.deltaLink` or the end, using the URLs verbatim — never rebuild, edit or log them. Never rely on `$top` alone.
- `mailApi.ts` read functions only: `getMe`, `listFolders`, `getWellKnownFolder(name)`, `messagesDelta(folderId, deltaLinkOrNull)`, `getMessageBody(id)`, `batch(requests)`. Message `$select` is exactly the §7 list. Persisted errors become `sync_state.error` / per-item failures later; this ticket just guarantees they are not swallowed.
- Tests with msw: 429 with `Retry-After`, 5xx backoff, forced refresh after 401, limiter accounting including a batch whose one throttled sub-response delays only itself, verbatim link following, typed errors, and folder response shape.

**Test command:** `npm test -- backend/test/graph.test.ts`
