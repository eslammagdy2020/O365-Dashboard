# T0: Freeze contracts & safety invariants

**Status:** frozen — owner-owned, NOT dispatched (orchestrator.md hard rule 2)

**Goal:** Fix the shared vocabulary and the safety invariants that every later worker reads before writing code. This is the "make the change easy" step: schema, type shapes and response shapes are frozen here so no implementation ticket has to invent them, and no worker ever edits schema or migrations.

**Depends on:** None (owner confirms frozen before any dispatch).

**Allowed files** (paths relative to `o365-command-center/`):
- `docs/contracts/M1-frozen.md`
- `backend/src/graph/types.ts`
- `backend/src/db/migrations/001_init.sql`
- `DECISIONS.md`

**Non-goals:**
- No runtime behaviour, API handlers, scoring, actions or UI.
- No mailbox reads or writes.
- No changes after confirmation; gaps go to `tickets/QUESTIONS.md`, not into these files.

**What the frozen contract must pin down:**
- `MessageRow` exactly as spec §12.1, response envelopes `{ data }` and `{ items, total, offset, limit }`, and the error shape `{ error: { code, message, requestId? } }` with the §12.1 code list.
- `sync_state` fields and the allowed `status` / `phase` values.
- Appendix A1: a delta `@removed` deletes the local row **only** if its current `folder_id` equals the folder reporting the removal; a removal from another folder is ignored. Omitted delta fields keep their cached values — never overwrite with null or defaults.
- Appendix A2: each `$batch` inner request consumes one slot of the global concurrency limit of 4; batches share that limiter with ordinary sync and detail calls; `Retry-After` is honoured per sub-response, not just on the batch response.
- Appendix C is acknowledged as deferred write-milestone work; it does not constrain Milestone 1.
- Milestone 1 scope: login → read-only sync → restart/resume → minimal read-only grid. No mailbox writes, no category writes, no bulk actions.
- The full §8 schema is created now — including tables that Milestone 2 will use — so later phases need no migration churn.

**Test cases:**
- `docs/contracts/M1-frozen.md` states A1, A2, the M1 scope line and the response/row shapes verbatim.
- `001_init.sql` contains every §8 table, index, FTS5 table and the three FTS triggers, and applies cleanly to a fresh database.
- `graph/types.ts` contains the frozen Graph shapes (`GraphMessage`, `Folder`, `DeltaResponse`, `GraphError`) and no others.
- A `contracts` test asserts the frozen strings so an accidental edit fails CI.

**Test command:** `npm test -- backend/test/contracts.test.ts` (owner-run verification only; T0 is not dispatched).
