# T7: All in-scope folders, window changes & scheduled sync

**Status:** ready-for-agent

**Goal:** Sync covers every folder Milestone 1 needs, stays current on its own, and handles configuration changes without losing the cache.

**Depends on:** T6.

**Allowed files** (paths relative to `o365-command-center/`):
- `backend/src/sync/syncService.ts`, `backend/src/sync/scheduler.ts`
- `backend/src/routes/settingsRoutes.ts`, `backend/src/controllers/settingsController.ts`
- `backend/src/routes/syncRoutes.ts`, `backend/src/controllers/syncController.ts`
- `backend/src/app.ts` (scheduler registration — shared file; run sequentially with other tickets that list it)
- `frontend/src/components/SyncStatusChip.tsx`, `frontend/src/pages/Mail.tsx`
- `backend/test/sync-folders.test.ts`

**Non-goals:**
- No mailbox writes or archive action — the Archive existence check only produces a warning in this milestone.
- No scoring, analytics, VIP/rules editors or AI.
- Do not edit schema/migrations or frozen Graph types.

**What to build (user-visible):** Inbox, Sent Items and Archive stay in sync automatically; changing the sync window in settings rebuilds the cache correctly; a missing Archive folder or a failed run produces a visible, persistent warning.

**Acceptance criteria / test cases:**
- Scope: Inbox, Sent Items and Archive. Deleted Items is optional and off by default. Check that Archive exists at the start of each sync; if not, add a persistent warning to `/api/sync/status` and a UI banner (no console prompt — the backend is headless).
- Incremental sync every 60 seconds (minimum configurable 30) and on `POST /api/sync/run`, guarded by the mutex from T6.
- `sync_state.window_days` records the window each folder's delta was built with. Raising the window clears every folder's `delta_link` and runs a full unfiltered resync, keeping existing rows until it completes. Lowering it only runs the retention cleanup.
- Hourly retention job: clear `undo_json` older than 24h, delete `action_log` rows older than 30 days, delete expired sessions and delete `ai_results` older than 90 days; nightly at 00:05 local time delete cached rows whose `effective_at` has aged out of the window.
- `/api/sync/status` keeps reporting phase, folder, counts, `lastSuccessAt`, `lastError`, `nextRunAt` and `warnings`; the UI chip and banner show them.
- Settings endpoints read/write the sync window, interval and folder selection with zod validation.
- Tests with mocked Graph: all three folders sync; raising the window clears delta links and triggers a full resync while keeping rows; lowering it only deletes aged rows; missing Archive yields a persistent warning; an edit in a synced folder appears locally within 2 minutes; all failures appear in `warnings`.

**Test command:** `npm test -- backend/test/sync-folders.test.ts`
