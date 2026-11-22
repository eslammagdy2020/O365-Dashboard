# T5: First inbox rows in a minimal grid

**Status:** ready-for-agent

**Goal:** The first full tracer bullet: a user signs in, runs a sync, and sees real cached messages in a read-only grid, with visible progress while the initial sync runs.

**Depends on:** T3 (Graph read client), T4 (database bootstrap).

**Allowed files** (paths relative to `o365-command-center/`):
- `backend/src/sync/deltaApplier.ts`, `backend/src/sync/syncService.ts`
- `backend/src/routes/syncRoutes.ts`, `backend/src/controllers/syncController.ts`
- `backend/src/routes/messageRoutes.ts`, `backend/src/controllers/messageController.ts`
- `backend/src/app.ts` (register routers — shared file; run sequentially with other tickets that list it)
- `frontend/src/services/ApiService.ts`, `frontend/src/pages/Mail.tsx`
- `frontend/src/components/EmailGrid.tsx`, `frontend/src/components/Navbar.tsx`
- `backend/test/sync-inbox.test.ts`, `frontend/test/email-grid.test.ts`

**Non-goals:**
- No mailbox writes of any kind; no actions, flags, categories, moves or deletes.
- No scoring, tiers, dashboard cards, waiting logic or analytics — scores stay null in this milestone.
- No detail drawer body rendering (that comes in T8), no scheduler or multi-folder scope (T7).
- Do not edit schema/migrations or frozen Graph types.

**What to build (user-visible):** A "Sync now" action pulls the Inbox into the local cache; a status badge shows progress; a minimal grid lists subject, sender and received date from the cache, and stays usable while syncing.

**Acceptance criteria / test cases:**
- `syncService.ts` runs an **unfiltered** `/me/mailFolders/{id}/messages/delta` with the frozen `$select` and `Prefer: odata.maxpagesize=50`. No `$filter` — Graph caps a filtered delta at 5,000 messages. An optional `$orderby=receivedDateTime desc` may be used as a UX optimisation but correctness must not depend on result order.
- `deltaApplier.ts` applies each page inside one SQLite transaction together with the next `resume_link` / final `delta_link`, so a crash never leaves applied rows without saved progress. Pages and links are followed verbatim and never logged.
- Compute `effective_at` as `sentDateTime` when `is_from_me`, otherwise `receivedDateTime`. `is_from_me` is derived at ingest by comparing the lowercased `from_address` with the `mail` and `userPrincipalName` from `getMe`. Keep `received_at` for display.
- Apply the local window: keep rows whose `effective_at` falls inside `syncWindowDays` (default 90); drop items outside it. Store only the cached message fields — scores, breakdown and auto-categories stay null.
- Appendix A1: an `@removed` item deletes the local row only when its current `folder_id` matches the folder reporting the removal; omitted delta fields keep their cached values. Tests cover Inbox-removal-first, Archive-added-first and duplicate replay of each, with identical final state in all cases.
- `GET /api/sync/status` returns `{ data: { phase, folder, counts, lastSuccessAt, lastError, nextRunAt, warnings } }`; `POST /api/sync/run` starts a run. `GET /api/messages?view=inbox&offset=&limit=&sort=&order=` returns `{ items, total, offset, limit }` with rows in the frozen `MessageRow` shape.
- Frontend: a minimal AG Grid Infinite Row Model grid (page size 100) with Sender, Subject and Received columns, plus a sync-status chip and sign-out. No scoring UI.
- Tests: delta upsert and effective_at for inbound vs from-me; window applied; A1 ordering/replay equivalence; progress endpoint during a multi-page sync; paged list shape; grid renders server rows.

**Test command:** `npm test -- backend/test/sync-inbox.test.ts && npm test -- frontend/test/email-grid.test.ts`
