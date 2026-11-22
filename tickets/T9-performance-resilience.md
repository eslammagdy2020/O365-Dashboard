# T9: 50k performance & resilience verification

**Status:** ready-for-agent

**Goal:** Prove the read-only cache meets its speed target at scale and that every sync failure mode is recoverable, before the final integration test is dispatched.

**Depends on:** T7, T8.

**Allowed files** (paths relative to `o365-command-center/`):
- `backend/test/performance.test.ts`, `backend/test/sync-resilience.test.ts`
- `backend/test/fixtures/generate-50k.ts`
- `package.json` (add the `perf` script — shared file; run sequentially with T1 if needed)
- `README.md` (record measured results and the manual live-tenant checklist)

**Non-goals:**
- No production code changes to scoring, actions, analytics or writes.
- No live Graph calls — all sync scenarios use msw mocks.
- Do not edit schema/migrations or frozen Graph types.

**What to build (user-visible):** A repeatable `npm run perf` command reports p95 query times on a synthetic 50,000-message mailbox, and the resilience suite passes green.

**Acceptance criteria / test cases:**
- Synthetic dataset: 50,000 messages — 60% Inbox, 30% Sent Items, 10% other, 255-character previews, 5,000 distinct senders.
- On the reference machine (Windows 11, 4 cores, 16 GB RAM, SSD), p95 of grid page queries MUST be under 200 ms for page-by-received-date and FTS search. The by-score index exists in the frozen schema, but scores are null in Milestone 1, so a meaningful by-score benchmark is deferred until scoring lands in Milestone 2 — record this explicitly in `README.md`.
- Sync resilience suite (mocked Graph): restart during initial sync resumes; network drop; expired token; progress saved in the same transaction as each page; raising the window triggers a full resync while lowering only cleans up; every failure appears in `warnings` and none requires a database reset.
- All tests run against msw mocks; no test performs a write against a live mailbox and no test calls live Graph.
- `README.md` gains the manual live-tenant checklist: login, initial sync, incremental sync, token expiry, Conditional Access prompt, and the live edit-appears-within-2-minutes check.

**Test command:** `npm run perf && npm test -- backend/test/sync-resilience.test.ts`
