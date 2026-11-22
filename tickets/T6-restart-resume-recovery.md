# T6: Restart, resume & recovery

**Status:** ready-for-agent

**Goal:** A failed or interrupted sync never loses progress and never needs a database reset: the cached account is reused silently, an interrupted run resumes from its saved link, and an invalid delta token triggers a safe full resync.

**Depends on:** T5.

**Allowed files** (paths relative to `o365-command-center/`):
- `backend/src/sync/syncService.ts`, `backend/src/sync/deltaApplier.ts`
- `backend/src/app.ts` (shutdown hooks to abort in-flight Graph requests — shared file; run sequentially with other tickets that list it)
- `backend/test/sync-recovery.test.ts`

**Non-goals:**
- No mailbox writes, no scoring, no scheduler cadence changes (T7), no extra folders (T7).
- Do not edit schema/migrations or frozen Graph types.
- Never log `nextLink` or `deltaLink` — they carry opaque sync tokens.

**What to build (user-visible):** Killing the backend halfway through a sync and restarting it continues where it left off. If Graph rejects a delta token, the app quietly rebuilds the folder from scratch and keeps working. Any failure shows a warning instead of disappearing.

**Acceptance criteria / test cases:**
- On startup and on `POST /api/sync/run`, reuse the cached account via `acquireTokenSilent`. If silent acquisition fails, pause sync and set status `login_required`.
- Only one sync runs at a time (mutex). Shutdown aborts all in-flight Graph requests and stops the scheduler before closing the database.
- `resume_link` / `delta_link` is committed in the same transaction as the page rows it describes (verify across an injected crash).
- HTTP 410 with `syncStateNotFound` or `resyncRequired`: clear that folder's `delta_link`, run a full unfiltered resync, and delete rows not seen in it (tracked by `last_seen_sync`) **only after the resync completes successfully**.
- A failed run — expired authentication, throttling beyond the retry limit, network loss, invalid delta token — sets `sync_state.status` to error with the message, appears in `/api/sync/status` `warnings`, and is retried on the next cycle. Recovery never requires deleting the database.
- Tests: kill mid-initial-sync then restart resumes with no duplicate or missing rows; network drop; expired token; progress saved in the same transaction as each page; 410 recovery with delayed stale-row deletion; every failure present in `warnings` and none needs a reset.

**Test command:** `npm test -- backend/test/sync-recovery.test.ts`
