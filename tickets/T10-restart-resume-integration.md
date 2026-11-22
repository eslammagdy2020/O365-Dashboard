# T10: Restart/resume integration test

**Status:** ready-for-agent — dispatch only after T9 is Done (orchestrator.md "Finish").

**Goal:** One end-to-end test that proves the whole Milestone 1 chain survives a real interruption: sign in, start an initial sync, kill the process mid-sync, restart, resume, and end with a complete and consistent grid.

**Depends on:** T9. (All implementation tickets T1–T9 must be Done before this is dispatched.)

**Allowed files** (paths relative to `o365-command-center/`):
- `backend/test/restart-resume.integration.test.ts`
- `backend/test/fixtures/` (only new files not already owned by T9)

**Non-goals:**
- No production code changes. If the test exposes a defect, report it to the orchestrator — do not fix it here.
- No mailbox writes, no live Graph, no real credentials.

**What to build (user-visible):** A single test command that demonstrates: login → interrupted initial sync → process restart → resumed sync → grid shows the full dataset with no lost or duplicated rows.

**Acceptance criteria / test cases:**
- Uses msw to mock Entra and Graph; no live tenant access.
- Interrupts a multi-page initial sync after a known page, restarts the application process, and confirms sync resumes from the saved `resume_link` rather than starting over.
- Final local state matches a uninterrupted control run: identical row count and content, no duplicates, no rows stranded with stale progress.
- Appendix A1 ordering is exercised in the real flow: Inbox-removal-first, Archive-added-first and duplicate replay of each converge to the same final state.
- Appendix A2 is exercised: a batch with a throttled sub-response shows only that sub-request retried, and concurrency never exceeds 4 including batch inner requests.
- The grid endpoint after resume returns the complete cached set with a correct `total`, and the status endpoint shows no unresolved error.

**Test command:** `npm test -- backend/test/restart-resume.integration.test.ts`
