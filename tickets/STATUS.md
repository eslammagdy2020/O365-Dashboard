# Milestone 1 — Build Status

Spec: `Office 365 Command Center Build Specification.md` (frozen)
Brief: `orchestrator.md`
Dispatch gate: **APPROVED** — owner confirmed T0 complete on 22 Nov 2026.
Worker model (all tickets): `coarena/gpt-6-luna` (GPT-6 Luna, Coarena free).
Execution mode: **strictly sequential — no parallel runs**. One ticket per worker, next dispatched only after the previous is Done.
Integration lane: **owner-approved standing lane** (`QUESTIONS.md`) for composition-root seams — `frontend/src/App.tsx`, `frontend/src/main.tsx`, `backend/src/server.ts`, `backend/src/app.ts`, manifests/lockfile. Invoked only after a ticket is verified green but unwired; logged per use.High-risk items (schema/migrations/contracts, cross-ticket API gaps, credentials, two real code failures) still escalate.

## Setup complete

- Git repo initialised at `E:\AI\O365` (branch `main`), baseline commit `742ffc5` containing the spec, tickets, STATUS and T0 artifacts. Worker changes are verified with `git diff --name-only` against this baseline.
- Frozen contract paths given to every worker:
  - `o365-command-center/docs/contracts/M1-frozen.md`
  - `o365-command-center/backend/src/graph/types.ts`
  - `o365-command-center/backend/src/db/migrations/001_init.sql`
  - `o365-command-center/backend/test/contracts.test.ts` (owner-owned guard test)
  - `Office 365 Command Center Build Specification.md`
- Owner guide for the manual Entra registration: `tickets/ENTRA-APP-REGISTRATION-GUIDE.md`.
- Gaps/conflicts logged in `tickets/QUESTIONS.md` (Q7–Q11 open, none blocks T1).

## Dependency graph (from ticket "Depends on" fields)

```text
T0 (owner-owned, confirmed frozen; not dispatched)
└── T1  Scaffold, config & health
    ├── T2  Entra sign-in ──> T3  Graph read client ──┐
    │                                                  ├──> T5  First inbox grid
    └── T4  DB bootstrap & FTS ───────────────────────┘
        T5 ──> T6  Restart/resume ──> T7  Folders/window/scheduler ──┐
        T5 ──> T8  Browse/search/detail ────────────────────────────┼──> T9  50k perf/resilience ──> T10  Integration test
```
T7 and T8 overlap on `frontend/src/pages/Mail.tsx`; with no-parallel mode this is moot, but the order below still respects it.

## Ticket table

| ID | Title | Depends on | Status | Attempts |
|----|-------|------------|--------|----------|
| T0 | Freeze contracts & safety invariants | — | Confirmed frozen (owner); not dispatched | 0 |
| T1 | Scaffold, config & health | T0 | **Done** — verified; owner approved extra files + T0 amendment | 1 |
| T2 | Entra sign-in with a persistent session | T1 | **Done** — verified 5/5 ticket tests, 21/21 full suite | 1 |
| T3 | Resilient Graph read client & folders API | T2 | **Done** — one-off API extension accepted (Q21) | 2 |
| T4 | Local mailbox database bootstrap & FTS | T1 | **Done** — owner accepted ledger + wiring; smoke tested | 1 |
| T5 | First inbox rows in a minimal grid | T3, T4 | **Done** — 4/4 backend, 1/1 frontend, 33/33 suite; Q23 mount verified | 3 |
| T6 | Restart, resume & recovery | T5 | **Done** — 4/4 ticket, 37/37 suite; startup/shutdown wired via lane | 1 |
| T7 | All in-scope folders, window changes & scheduled sync | T6 | **Done** — 5/5 ticket, 49/49 suite; 2 documented deviations | 2 |
| T8 | Browse, search & read safely | T5 | **Done** — 5/5 + 2/2 ticket, 44/44 suite; detail wired via lane | 1 |
| T9 | 50k performance & resilience verification | T7, T8 | **Done** — perf p95 ~11 ms, 4/4 resilience, 54/54 suite | 1 |
| T10 | Restart/resume integration test | T9 | **Done** — 1/1 integration test, 55/55 suite; M1 complete | 1 |

## Dispatch order (sequential)

1. T0 — owner confirmation (done).
2. T1 — scaffold, config, health.
3. T4 — DB bootstrap & FTS (depends only on T1).
4. T2 — Entra sign-in (depends on T1).
5. T3 — Graph read client (depends on T2).
6. T5 — first inbox grid (depends on T3 + T4).
7. T6 — restart/resume (depends on T5).
8. T8 — browse/search/detail (depends on T5).
9. T7 — folders/window/scheduler (depends on T6; also resolves the `Mail.tsx` overlap with T8).
10. T9 — performance & resilience (depends on T7 + T8).
11. T10 — restart/resume integration test, only after T9 is Done.

T4 and T2 are both eligible after T1; T4 is placed first because it is smaller and T2/T3/T5 all depend on the database being bootstrapped in practice. No two tickets run at the same time.

## T1 final verification (attempt 1 — accepted by owner)

- Ticket command verified by orchestrator: `npm test -- backend/test/health.test.ts` → 4 passed; `npm run lint` → clean; `npm run build` → clean. (PowerShell rejects `&&`; steps run separately — environment issue, not a worker deviation.)
- Non-goals respected: `app.ts` mounts only health, with a single registration comment for later tickets; no auth/Graph/DB/sync/scoring code present.
- Listed test cases exist: health 200, missing and 31-char secret rejection, all derived paths move with `DATA_DIR`.
- Out-of-scope files `docs/DECISIONS.md` and `frontend/tsconfig.tsbuildinfo` were explicitly approved by the owner to keep (QUESTIONS.md Q12, Q13).
- Owner-approved T0 amendment applied by a separate worker: two frozen files plus migration header only. Verified diff shows exactly the approved edits; full `npm test` → 13 passed, 0 failed; `npm run lint` clean. No test assertions weakened.
- `git add -N` applied so `git diff --name-only` lists all new worker files.

## T4 final verification (attempt 1 — accepted by owner)

- `npm test -- backend/test/db.test.ts` → 3 passed; full `npm test` → 16 passed; lint and build clean.
- Scope: only `backend/src/db/db.ts` and `backend/test/db.test.ts` from the ticket; frozen migration untouched; no `VACUUM`, parameterized SQL, `ON CONFLICT ... DO UPDATE`, UTC ISO dates, FTS rebuild after migration.
- Owner accepted the runtime `schema_migrations` ledger (Q17) and authorised the one-off `server.ts` wiring (Q18). Verified `openDatabase()` is called before listen and the handle is closed on shutdown; diff limited to `server.ts`.
- Live smoke test with a temp `DATA_DIR`: `/api/health` → 200; `data.sqlite`, `-wal` and `-shm` created.

## T2 verification (attempt 1 — accepted)

- `npm test -- backend/test/auth.test.ts` → 5 passed; full `npm test` → 21 passed; lint and backend build clean.
- Scope: only `backend/.env.example`, `backend/src/app.ts`, `backend/src/auth/*`, `backend/src/db/sessionStore.ts`, `backend/test/auth.test.ts`. Frozen contracts, schema and migrations untouched.
- Test cases present: PKCE + state + S256, replayed state rejection, session id regeneration, session survives app rebuild/restart, `/api/*` 401 `login_required`, wrong Host/Origin/missing `X-Requested-With` 403, Lax cookie callback, no token material in responses, claims challenge forwarded, single-mailbox rule, logout removes cached account.
- Non-goals respected: no mailbox or Graph calls beyond token acquisition.

## T3 final verification (attempt 2 — accepted)

- Attempt 1 failed externally (Coarena daily quota); owner replaced the API key and authorised retry. Attempt 2 fixed a limiter deadlock (duplicate slot reservation, slots held during backoff) and a paging-link cycle.
- `npm test -- backend/test/graph.test.ts` → 6 passed; full `npm test` → 27 passed; lint and backend build clean.
- Scope: only the seven allowed T3 files; frozen types, schema and migrations untouched.
- Test cases present: bearer/Prefer/client-request-id headers, 429 `Retry-After`, 503 backoff, typed 4xx error, one forced refresh after 401 then `login_required`, verbatim next/delta links, A2 batch slot accounting with per-sub-response `Retry-After` (max concurrency ≤ 4), folders `{ data: [...] }` with well-known identification.

## Q21 one-off Graph API extension — verified and accepted

- Owner authorised a one-off worker limited to `mailApi.ts`, `graphClient.ts`, `graph.test.ts`. Timestamps confirm only those three files changed.
- `messagesDeltaPages()` yields each page with its verbatim `@odata.nextLink`/`@odata.deltaLink`; `messagesDelta()` aggregation wrapper retained. `get()` takes optional extra headers; `Prefer: odata.maxpagesize=50` is merged with `IdType="ImmutableId"` and bearer/client-request-id are always set by the client. No link logging; frozen types untouched.
- `npm test -- backend/test/graph.test.ts` → 7 passed; full `npm test` → 28 passed; lint and backend build clean.

## Open items

## T5 final verification (attempt 3 — accepted)

- `npm test -- backend/test/sync-inbox.test.ts` → 4 passed; `npm test -- frontend/test/email-grid.test.ts` → 1 passed; full `npm test` → 33 passed; lint and frontend build clean.
- Final-round timestamps show only `deltaApplier.ts` and `syncService.ts` changed; the full T5 implementation is confined to its allowed files. Five tests cover all seven acceptance cases: unfiltered frozen-select delta with `Prefer: odata.maxpagesize=50`, per-page transactional continuation saving, effective_at inbound/from-me with null scores, local window, A1 ordering/replay equivalence, multi-page progress + paged MessageRow list, grid renders server rows. No `$filter`, mailbox writes or scoring.
- **Integration lane invocation #1 (Q23):** verified-green T5 was unwired because `frontend/src/App.tsx` (T1-owned) still rendered the placeholder. Lane worker on `coarena/gpt-6-luna` changed only `App.tsx` to render `<Mail />`; re-verified 33/33, lint, frontend build. Non-blocking Vite chunk-size warning noted.

## T6 final verification (attempt 1 — accepted)

- `npm test -- backend/test/sync-recovery.test.ts` → 4 passed; full `npm test` → 37 passed; lint and backend build clean.
- Scope: only `syncService.ts`, `deltaApplier.ts`, `app.ts` and the new `sync-recovery.test.ts`. Ticket cases present: mutex, silent-auth failure → `login_required`, transactional crash resume, 410 `syncStateNotFound`/`resyncRequired` full resync with delayed stale-row deletion via `last_seen_sync`, failure warnings, no database reset.
- **Integration lane invocation #2:** T6 exposed `app.locals.shutdown()` but the process never called it, and resume was lazy. Lane worker (same model) changed only `app.ts` + `server.ts`: single shared DB handle, `app.locals.initialise()` called before listen, graceful signal shutdown awaits `app.locals.shutdown()` before exit. Re-verified 37/37, lint, backend build; live smoke with temp `DATA_DIR` → health 200 and `data.sqlite` created.

## T8 final verification (attempt 1 — accepted)

- `npm test -- backend/test/messages-api.test.ts` → 5 passed; `npm test -- frontend/test/body-sanitizer.test.ts` → 2 passed; full `npm test` → 44 passed; lint and both builds clean (non-blocking Vite chunk-size warning).
- Scope: only T8's nine allowed files. Cases present: six in-scope views, max-200 paging with whitelisted sort and full filtered `total`, FTS escaping/phrase with stripped operators and quoted phrases, `unicode61`, detail response with null breakdown + raw bodyHtml, DOMPurify + `data-blocked-src` rewriting + sandboxed `srcDoc` with opt-in image loading, last-synced time and stale banner on failed/offline/login-required sync. No writes or scoring.
- **Integration lane invocation #3:** T8's detail route needs an authenticated `MailApi` injected from `app.ts` (outside its allow-list) or it returns 503. Lane worker changed only `app.ts`: a `getMailApi(request)` callback reads the session account, calls `acquireGraphToken` via `clientProvider()`, returns `createMailApi(...)`; passed into `createMessageRoutes`. Re-verified 44/44, lint, backend build.

## T7 final verification (attempt 2 — accepted with documented deviations)

- `npm test -- backend/test/sync-folders.test.ts` → 5 passed; full `npm test` → 49 passed; lint, backend and frontend builds clean (non-blocking Vite chunk-size warning).
- Scope: only T7's allowed files. Five tests cover three-folder sync, persistent missing-Archive warning, raise-window full resync retaining rows until completion, lower-window retention only, and zod validation with delta clearing. Scheduler is registered in `app.ts`, started at runtime init, and stopped in `app.locals.shutdown()`; no extra composition-root seam was needed.
- **Deviation 1 (non-blocking):** T6's `sync-recovery.test.ts` prints MSW unhandled-request errors for Archive/Sent folder checks because its fixtures predate T7. Tests pass; worker deliberately kept real failure reporting rather than suppressing errors. Fix by adding handlers when that fixture is in scope.
- **Deviation 2:** settings read/write endpoints are implemented with zod validation, but no settings editor UI was added (`ApiService.ts` and any settings page are outside T7's allow-list). Window changes are verifiable via the API; UI editor deferred.

## T9 final verification (attempt 1 — accepted)

- `npm run perf` → 50k synthetic mailbox (60% Inbox / 30% Sent / 10% other, 255-char previews, 5,000 senders), measured p95: received-date page **10.79 ms**, FTS search **10.24 ms** (target < 200 ms). Re-run during full suite: ~11.2 ms / ~10.2 ms.
- `npm test -- backend/test/sync-resilience.test.ts` → 4 passed; full `npm test` → 54 passed; lint clean.
- Scope: only T9's five allowed files. README records measured results, the environment caveat (reference machine not verified), the explicit by-score deferral to Milestone 2, and the manual live-tenant checklist. Benchmark uses in-memory SQLite — no stray 50k files. Deviation: the existing T6 mock warnings are unchanged.

## T10 final verification (attempt 1 — accepted)

- `npm test -- backend/test/restart-resume.integration.test.ts` → 1 passed; full `npm test` → 55 passed; lint and `npm run build` clean.
- Scope: only the new `backend/test/restart-resume.integration.test.ts`; no production code, schema, manifest or T9 fixture touched.
- Test covers mocked sign-in, multi-page initial sync interrupted after a known page, in-process restart, resume from saved `resume_link`, equality with an uninterrupted control run (row count/content, no duplicates/stale progress), A1 ordering/replay convergence, A2 selective sub-request retry with concurrency ≤ 4, and final grid `total` + clean status.

## Milestone 1 complete

All 10 tickets Done. Final verification: `npm test` **55/55 passed**; `npm run perf` p95 ~11 ms for 50k received-date pages and FTS search (< 200 ms target); `npm run lint` clean; backend and frontend builds clean; live boot smoke test health 200 with `data.sqlite` created.

**Post-review remediation (23 Nov):** independent review returned Request changes (R1–R4); owner approved a sequential remediation lane (F1–F4) on `coarena/gpt-6-luna`. M1 is **not final** until the four fixes are verified and re-reviewed.
- **F1 (R1) accepted:** `authRoutes.ts` now receives a `startScheduler` callback from `app.ts` and calls it after the new session is saved; `auth.test.ts` asserts a fresh sign-in yields non-null `nextRunAt` with no explicit sync request. Verified 6/6 auth, 56/56 suite, lint/backend build clean, only the three permitted files changed.
- **F2 (R2) accepted:** `syncService` constructor loads the latest non-null persisted error across all statuses (stripping the resync marker); `sync-recovery.test.ts` adds a restart regression. Verified 5/5 recovery, 57/57 suite, lint/backend build clean, only the two permitted files changed.
- **F3 (R3) accepted:** `messageController` accepts an optional `folder` param and returns 400 `validation_error` for anything other than Inbox (well-known name or Inbox id); two regression tests added. Verified 7/7 messages API, 59/59 suite, lint/backend build clean, only the two permitted files changed.
- **F4 (R4) accepted:** `app.ts` serves `frontend/dist` when present with an SPA fallback that never answers unknown `/api/*` with HTML; injectable static dir for tests; README updated. Verified 1/1 static-serving test, 60/60 suite, lint/backend build clean, only the three permitted files changed. Production-style smoke: `GET /` 200 with React root div, `/api/health` 200, unknown `/api` returned JSON error not SPA.
- **Final verification after all fixes:** `npm test` 60/60; `npm run perf` p95 ~13 ms received-date / ~12 ms FTS; `npm run lint` clean; backend + frontend builds clean.
- **F5 (follow-up review) accepted:** `README.md` documents `FRONTEND_URL=http://localhost:5000` for the production-style run (with restart) and aligns the dev URL with the default `FRONTEND_URL`; `backend/.env.example` comments that the value must match the browser URL. Verified 60/60, lint/backend build clean, only those two documentation files changed.
- **Repeat review verdict: APPROVE.** Second review confirmed R1–R4 Resolved, found F5; focused third review confirmed F5 Resolved, no new Required issues, 60/60 tests and lint clean. Final verdict **Approve**.

## Live-tenant check results (23 Nov 2026) — two defects found, fixes pending owner approval

Owner ran the app against the live tenant. Sign-in and sync worked (grid showed 539 cached rows; last synced 12:36:56 PM; next automatic sync populated). Two defects surfaced:

**L1 — backend crashes with `ERR_INVALID_STATE` (FileHandle GC) on Node 25.8.1.** Deterministic repro: `C:\Users\emagdy\AppData\Local\Temp\opencode\occ-cache-gc-repro.mjs` (call plugin `beforeCacheAccess`, simulate the unlock ENOENT branch, drop the plugin, `global.gc()`) reproduces the owner's exact error and path (`token-cache.bin.lockfile`). Root cause chain: `app.ts:49` `clientProvider = () => createMsalClient(config)` creates a **new `PublicClientApplication` per request** (`requireAuth.ts:18`, `app.ts:228`, auth routes); each creates a `PersistenceCachePlugin` on the same DPAPI cache and `.lockfile` (`msalClient.ts:15`, `tokenCache.ts:16-20`). MSAL's `CrossPlatformLock.unlock()` unlinks before closing and skips `close()` on ENOENT/EPERM (library `msal-node-extensions.cjs:220-245`), leaking a FileHandle. Node 25 turned the GC finalizer from a deprecation warning into a fatal uncaught error. Upstream MSAL confirms these extensions were designed for desktop clients, not concurrent web apps. Fix needs a single shared client + serialised MSAL cache access (or a single-process DPAPI cache plugin without the lockfile).

**L2 — frontend is completely unstyled.** Verified with headless Edge screenshot and HTTP: CSS/JS both return 200 with correct MIME types, but `frontend/src` contains **no `.css` file at all** and no stylesheet import in `main.tsx`. The ~20 semantic class names (`navbar`, `mail-page`, `sync-chip`, `mail-toolbar`, …) and `ag-theme-quartz` have no definitions; the emitted 225 KB CSS is only AG Grid legacy base styles pulled in by a dependency. Fix: add a real stylesheet (app classes + AG Grid theme CSS) and import it from `main.tsx`, with a regression check that the classes used in components are defined.

Owner approved "Fix both, sequential lane" on `coarena/gpt-6-luna`: L1 first, then L2, then full re-verification and repeat independent review. Lane charter recorded in `QUESTIONS.md`.
- **L1 accepted:** `tokenCache.ts` now uses DPAPI persistence directly behind an in-process mutex (no cross-process `.lockfile`); `app.ts` memoises one MSAL client per runtime. Verified 1/1 new regression, 18/18 focused auth/graph/recovery, 61/61 full suite, lint/backend build clean, only the three permitted files changed. Original fatal repro re-run against rebuilt code: `SURVIVED`, exit 0.
- **L2 accepted:** new `frontend/src/index.css` defines all component classes; `main.tsx` imports AG Grid base + quartz theme and the app CSS; `stylesheet.test.ts` guards against undefined classes. Verified 1/1 focused, 62/62 full suite (17 files), lint/frontend build clean, only the three permitted files changed. Built CSS contains `.navbar`, `.mail-page`, `.sync-chip`, `.email-grid`, `.message-detail-drawer` and 776 `ag-theme-quartz` references. Perf p95 ~15 ms received-date / ~13 ms FTS.
- **Grid rendering lane (23 Nov): owner approved a one-worker frontend fix.** Evidence: `/api/messages?…q=visit` returns 4 correct rows (confirmed in owner's Network Response); the 4 rows exist in the live DOM with correct text and geometry (`ag-center-cols-container` 873×168 aligned with viewport, overlay `display:none`, `visibility:visible`, `opacity:1`, dark text); no console errors; disabling `bis_skin_checked` extensions did not help. Rows are simply not painted in the owner's browser. Dispatched a frontend-only worker to give `.email-grid` a definite height and force a redraw after rows arrive.
- **Grid rendering lane accepted (pending owner live check):** `.email-grid` now has explicit `height: 24rem`; `EmailGrid.tsx` calls `sizeColumnsToFit()` on grid ready; dead inline style removed from `Mail.tsx`; new `frontend/test/grid-render.test.ts` guards the height/redraw. Verified 63/63 tests (18 files), lint clean, frontend build clean, only the four permitted files changed. Worker's headless screenshot shows headers and rows painted; worker could not reproduce the blank-grid symptom in a clean profile. Owner rebuilt, restarted, hard-refreshed and confirmed **rows are now visible** in their own browser — live acceptance passed.
- **Final review of grid lane — self-reviewed by orchestrator (independent reviewers unavailable: three providers failed on free-usage limits/routing).** No Required findings. Verified: change is limited to the four frontend files; no backend/contract/schema/manifest/dependency changes; `sizeColumnsToFit` exists in the AG Grid 32.3.9 bundle and typechecks (`tsc -p frontend/tsconfig.json --noEmit` exit 0); optional call is safe and flex/minWidth columns fit the 873 px viewport. New test is a lightweight source-text guard (not a rendering test) — real rendering evidence is the owner's live confirmation plus the worker's screenshot. Earlier F1–F5 / L1 / L2 and frozen files untouched. Verdict: **Approve**.

**Owner decision (23 Nov): HOLD.** After the Approve verdict the owner chose to make no further changes and not commit yet; possibly re-running the live-tenant check first. No workers running, no git writes, nothing pushed. Everything remains uncommitted on `742ffc5`.

**Final independent review verdict: APPROVE.** L1 and L2 both **Resolved**; F1–F5 and frozen contracts intact; no new Required findings. Reviewer re-ran 62/62 tests, lint, focused tests and backend typecheck. Optional 1 noted: the `no .lockfile` assertions in `token-cache.test.ts` are structurally vacuous with an injected fake persistence; production code provably has no cross-process lock, so non-blocking. Optional 3 noted: a rejected memoised `clientPromise` stays cached until restart (transient DPAPI failure becomes permanent); non-blocking.

## On hold — owner live-tenant acceptance (23 Nov 2026)

Owner chose to hold all further work (commit, Milestone 2 planning, cleanup lane) pending a manual live-tenant check. No workers are running and nothing will be dispatched until the owner reports back. The owner-run checklist is in `README.md` §"Manual live-tenant checklist": sign-in shows account without exposing tokens; initial Inbox/Sent Items/Archive sync with progress and cached rows; harmless Outlook edit appears locally within 2 minutes; incremental sync uses saved delta state; token expiry recovers via silent auth or pauses with a sign-in warning; Conditional Access/MFA prompt displays and sync resumes after completion. Automated tests use MSW mocks only and never touched a live tenant. All 72 changed paths remain uncommitted on `742ffc5`; nothing pushed.

All Q1–Q24 in `QUESTIONS.md` resolved. Q8 (actual VIP addresses) deferred to Milestone 2 per owner. All worker changes remain **uncommitted** on baseline `742ffc5`.

Non-blocking known issues carried forward: (1) T6's `sync-recovery.test.ts` mocks lack Archive/Sent handlers, producing MSW stderr noise but no failures; (2) no settings editor UI (endpoints are implemented; `ApiService.ts`/settings page were outside T7's allow-list); (3) Vite large-chunk warning; (4) npm install reported audit vulnerabilities; (5) benchmark environment not verified against the stated reference hardware — README requests a reference-machine rerun.
