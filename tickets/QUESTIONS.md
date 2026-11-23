# Questions & gaps log

## Grid rendering lane — owner-approved (23 Nov 2026)

Owner confirmed a fresh frontend defect after the L1/L2 approval: the AG Grid panel is blank in the owner's Edge even though all 4 matching rows are present in the DOM with correct text, correct geometry, hidden overlay, no console errors, and correct network response. Disabling `bis_skin_checked`-injecting extensions did not help. Owner approved one worker on `coarena/gpt-6-luna`, frontend-only: `frontend/src/index.css`, `frontend/src/components/EmailGrid.tsx`, optional `frontend/src/pages/Mail.tsx`, plus a regression test. Intent: give `.email-grid` a definite height, force a paint/redraw after rows arrive, remove the dead inline style fallback; verify with full suite, lint, frontend build and a headless screenshot. No backend/schema/contract changes.

## Live-run remediation lane — owner-approved (23 Nov 2026)

Owner ran Milestone 1 against the live tenant: sign-in and sync worked (539 cached rows), but two defects surfaced and were independently reproduced. Owner approved **Fix both, sequential lane**: one worker at a time on `coarena/gpt-6-luna`, no parallel work, no git writes, no live Graph/Entra access, mocks only. After both fixes: full re-verification and repeat independent review.

- **L1 — backend crash (`ERR_INVALID_STATE`, FileHandle GC) on Node 25.** Files: `backend/src/auth/tokenCache.ts`, `backend/src/auth/msalClient.ts`, `backend/src/app.ts`, new `backend/test/token-cache.test.ts`. Intent: eliminate the cross-process `.lockfile` FileHandle leak — use one MSAL client per process and a single-process DPAPI-backed cache plugin guarded by an in-process mutex; assert no `.lockfile` is created.
- **L2 — frontend has no stylesheet.** Files: new `frontend/src/index.css`, `frontend/src/main.tsx`, optional `frontend/test/stylesheet.test.ts`, possibly `frontend/package.json` only if a dependency import requires it. Intent: define all component classes and import AG Grid theme CSS; regression check that used classes are defined.

Rules: no schema/migrations/frozen contracts; do not weaken existing tests; each worker replies with files changed / test command + result / deviations / blockers. Deferred Optional/Nit items stay deferred.
- **Outcome (23 Nov):** L1 and L2 accepted and verified (62/62 tests). Final independent review verdict **Approve**, no Required findings. Optional 1 (vacuous `.lockfile` assertions), Optional 2 (unasserted save/deserialize), Optional 3 (rejected clientPromise memoised), Optional 4 (single-instance assumption) and two Nits remain deferred unless the owner authorises further work.

## Remediation lane — owner-approved (23 Nov 2026), from code-review-and-quality

Independent review of the full M1 change set (model `opencode/deepseek-v4.1-flash-free`) returned **Request changes** with four confirmed Required findings (R1–R4). Owner authorised a **remediation lane**: one worker at a time on `coarena/gpt-6-luna`, each fix with an explicit file list and a regression test, no ticket in parallel, then full re-verification and a repeat review.

- **F1 / R1** — first sign-in never starts the scheduler. Files: `backend/src/app.ts`, `backend/src/auth/authRoutes.ts`, `backend/test/auth.test.ts`.
- **F2 / R2** — persisted `lastError` lost after restart. Files: `backend/src/sync/syncService.ts`, `backend/test/sync-recovery.test.ts`.
- **F3 / R3** — `GET /api/messages?folder=` silently ignored. Files: `backend/src/controllers/messageController.ts`, `backend/test/messages-api.test.ts`.
- **F4 / R4** — `npm start` does not serve `frontend/dist`. Files: `backend/src/app.ts`, `README.md`, new `backend/test/static-serving.test.ts`.
- **F5 / follow-up review — RESOLVED.** Production/dev `FRONTEND_URL` documentation mismatch exposed while verifying F4; fixed in `README.md` and `backend/.env.example` only. Repeat independent review final verdict: **Approve** (F5 Resolved, R1–R4 Resolved, no new Required issues, 60/60 tests, lint clean).

Rules: no schema/migrations/frozen contracts/manifests; no git writes; no live Graph/Entra; do not weaken existing tests; each worker must reply with files changed / test command + result / deviations / blockers. Optional/Nit review items are deferred unless a fix exposes them.

## Integration lane — owner-approved standing authorisation (22 Nov 2026)

To avoid a separate escalation for every composition-root seam, the owner approved a **standing integration lane**:

- **Worker:** `coarena/gpt-6-luna`, one at a time, never in parallel with a ticket worker.
- **Fixed allowed files:** `frontend/src/App.tsx`, `frontend/src/main.tsx`, `backend/src/server.ts`, `backend/src/app.ts`, and the package manifests/lockfile (`package.json`, `package-lock.json`, `backend/package.json`, `frontend/package.json`).
- **Trigger:** a ticket is verified green but its stated user-visible outcome is unreachable because of one of those seams, or a prerequisite dependency is missing from the manifests.
- **Rules:** minimal wiring only; no schema, migrations, frozen contracts, feature logic or test weakening; no git writes; no live credentials; each invocation logged in `tickets/STATUS.md` with the triggering ticket and verification result.
- **Still escalated to owner:** schema/migration/contract changes, cross-ticket API changes outside the fixed file list (e.g. Q21), live tenant/credentials, and two genuine code failures.
- **Orchestrator verification change:** before marking any ticket Done, check that the feature is actually wired in (mounted/registered/started), not just that tests pass.

Owner decisions recorded 22 November 2026. Per `orchestrator.md` rule 3, gaps or conflicts in the spec, tickets or frozen contracts are logged here — never patched by the orchestrator.

## Resolved at kickoff

| # | Source | Gap / conflict | Owner decision | Status |
|---|--------|----------------|----------------|--------|
| Q1 | T0 / brief rule 2 | Frozen artifacts not present at first review | T0 is complete; artifacts exist under `o365-command-center/`; confirmation checkboxes are `[x]` | Resolved |
| Q2 | Brief step 5 | `E:\AI\O365` was not a git repo, so `git diff --name-only` verification was impossible | Orchestrator to run `git init`; done — repo at `E:\AI\O365`, baseline commit `742ffc5` | Resolved |
| Q3 | T0 allowed files / test cases | `backend/test/contracts.test.ts` required by T0's test cases and test command but omitted from T0's allowed-files list | Owner confirmed the test is present and T0 is complete; treated as an owner-owned T0 artifact, not a worker-editable file | Resolved |
| Q4 | T8 vs T7 | T8 says it may run in parallel with T7, but both list `frontend/src/pages/Mail.tsx` | **No parallel runs at all** — every ticket runs alone, sequentially | Resolved |
| Q5 | Brief rule 4 | Exact worker model ID needed | Use `coarena/gpt-6-luna` for every ticket worker | Resolved |
| Q6 | Spec §5 / §20 | Live tenant work and owner questions | Owner owns the Entra app registration; guide at `tickets/ENTRA-APP-REGISTRATION-GUIDE.md`; answers written into spec §20 | Resolved (see follow-ups) |

## Open — need owner clarification (none blocks T1)

- **Q7 — `DECISIONS.md` missing.** T0 lists `DECISIONS.md` as an allowed file, but it does not exist. The owner answered spec §20 in the spec `.md` instead. Should `DECISIONS.md` be created (owner-owned, T0), or is the annotated spec §20 the authoritative decision record? The orchestrator will not create it without instruction.
-**A7 - i created it inside \docs folder
- **Q8 — §20 Q2 answer "adresses".** This specifies the *type* (addresses) but gives no actual VIP/Manager addresses or group names. Not needed for Milestone 1 (no scoring); needed before any Milestone 2 scoring work.
- **A8 - a'll supply it later before phase 2
- **Q9 — §20 Q5 answer "YES" is ambiguous.** It is unclear whether this means Deleted Items **should** be synced. T7 and the frozen contract both say Deleted Items is optional and off by default. Confirm before T7 is dispatched if a scope change is intended; otherwise the frozen "off by default" stands.
**A9 - it is off
- **Q10 — §20 Q3 left blank** (write auto categories to Outlook). Default is "no"; Milestone 1 has no writes, so the orchestrator will assume "no" until revisited for Milestone 2.
- **A10 - go with the default 
- **Q11 — stale PROPOSAL headers.** `docs/contracts/M1-frozen.md`, `backend/src/graph/types.ts` and `001_init.sql` still say "PROPOSAL — pending owner confirmation" in their header comments, while their confirmation checkboxes are `[x]` and the owner has confirmed. Cosmetic only; needs owner decision whether to update the headers (T0-owned files, orchestrator will not edit).
- **A11 - yes update them  it is confirmed** — owner-approved header cleanup assigned to the T0 amendment worker.

## Escalations from T1 verification — owner decisions

- **Q12 — `docs/DECISIONS.md` created by T1 worker:** owner says they created it and it must be kept. Resolved — keep the file; it also answers Q7 (DECISIONS.md now exists, under `docs/`).
- **Q13 — `frontend/tsconfig.tsbuildinfo` build artefact:** owner says keep it. Resolved — keep as-is (it is a regenerable TypeScript incremental-build cache).
- **Q14 — owner-owned `contracts.test.ts` failures:** owner approved the **T0 contract amendment**. Resolved by two casing/formatting edits to the frozen artifacts (lowercase "at most 20 sub-requests", and multi-line `flag` declaration) being applied by a worker. The guard test itself was not weakened.
- **Q15 — `git diff --name-only` verification:** owner approved `git add -N`. Resolved — applied to `o365-command-center/`; new worker files now appear in `git diff --name-only`.

## Q19 — open: T3 worker quota exhausted (escalation)

The T3 worker (`coarena/gpt-6-luna`, attempt 1) hit the provider's daily free-usage limit while verifying; the provider reports reset at **00:00 UTC, about 11h47m from the failure**. It wrote all six allowed files (`graphClient.ts`, `batch.ts`, `mailApi.ts`, `folderRoutes.ts`, `folderController.ts`, `graph.test.ts`) and edited `app.ts` (also allowed); no files outside T3's allow-list were touched. **Nothing was verified or accepted.** Several orphan `node` test processes from the failure were still running at check time.

**Owner chose (b): replaced the Coarena API key and asked for a retry.** T3 attempt 2 dispatched on the same model, resuming the worker session with its partial files. The orphan `node` processes exited on their own before cleanup was needed.

## Q20 — extension of approved dependency lane (T5 prerequisite)

T5's exact test command includes `frontend/test/email-grid.test.ts`, which needs a DOM test environment; `jsdom`, `@testing-library/react` and `@testing-library/jest-dom` are absent, and T5's allowed files exclude all manifests. Treating this as covered by the owner-approved Q16 dependency lane, a one-off worker will add those three frontend devDependencies only. Logged for transparency — no separate owner decision sought.

## Q21 — open: T3 read API cannot support T5's atomic per-page sync

T5 (attempt 1) made **no changes** and stopped immediately. Verified blocker in T3's code:
- `MailApi.messagesDelta()` → `pagedDelta()` collects every page into one `GraphDeltaResponse` and returns only the final `@odata.deltaLink`; it exposes neither the intermediate `@odata.nextLink` nor a per-page callback/iterator, so T5 cannot save `resume_link` in the same transaction as each page's rows.
- `GraphClient.get(url, signal)` has no per-request header option; `request()` unconditionally sets `prefer: IdType="ImmutableId"`, so T5 cannot add `Prefer: odata.maxpagesize=50` (nor would appending it be safe without care).
Both files are T3-owned and outside T5's allowed files. No schema, contract or spec change is needed.

**Owner authorised the recommended one-off extension worker** (same model; `mailApi.ts`, `graphClient.ts`, optionally `graph.test.ts`). **Extension verified and accepted:** `messagesDeltaPages()` exposes per-page verbatim links, `get()` accepts extra headers while preserving ImmutableId/bearer/client-request-id; 7/7 graph tests, 28/28 full suite, lint/build clean, only the three permitted files touched. T5 retried unchanged (attempt 2).

## Q22 — open: T5 attempt 2 hit Coarena daily quota a second time

T5 attempt 2 wrote its allowed files before the provider cut off the session (`Today's free usage is used up … resets at 00:00 UTC, in 10 h 41 min`). No hung `node` processes remain. **Nothing is accepted** — orchestrator re-ran the commands:
- `npm test -- backend/test/sync-inbox.test.ts` → 3 passed / **1 failed**: A1 convergence case, expected `{ id: 'move-me', folder_id: 'archive-id', subject: 'Subject move-me' }`, got `subject: null`. This is the "omitted delta fields keep cached values" rule (`deltaApplier.ts`).
- `npm test -- frontend/test/email-grid.test.ts` → 1 passed.
- Full `npm test` → 32 passed / 1 failed (same case); lint clean; frontend build clean.
- `backend/src/auth/authRoutes.ts` (not a T5-allowed file) had its mtime touched at 15:12; content read back is identical in behaviour to T2's implementation and all auth tests still pass — likely a no-op rewrite. Flag for the resumed worker to re-check.

**Owner chose (a): replaced the Coarena API key and asked to resume T5.** Resumed the same worker session on `coarena/gpt-6-luna` with the exact failing assertion, the full verification baseline, the allow-list reminder, and the `authRoutes.ts` mtime note. T5 remains unverified until the resumed run passes.

## Q24 — open: T7 cut off by Coarena daily quota (third occurrence)

T7 worker wrote all its allowed files (except `SyncStatusChip.tsx`, unchanged) and was cut off by the provider: `Today's free usage is used up … resets at 00:00 UTC, in 9 h 25 min`. No hung `node` processes. **The worker never reported**, so nothing is accepted. Orchestrator re-ran the checks:
- `npm test -- backend/test/sync-folders.test.ts` → 5 passed (three-folder sync, persistent missing-Archive warning, raise-window full resync retaining rows, lower-window local retention, zod validation + delta clearing).
- Full `npm test` → **49 passed**; `npm run lint`, backend and frontend builds clean.
- Concern: T6's `sync-recovery.test.ts` now emits MSW "unhandled request" errors for `GET /me/mailFolders/archive` and `/sentitems` (T7's new Archive/Sent existence checks run inside T6's mocks). Tests still pass, but the fixtures are stale and that test file is outside T7's allow-list.

**Owner chose (b): replaced the Coarena API key again and asked to resume T7.** Resumed the same worker session with the partial files, the orchestrator's green verification baseline, and the explicit MSW unhandled-request concern from T6's fixtures. T7 remains unverified until the worker reports.

## Q23 — open: Mail page is not mounted by the root shell

T5 attempt 3 is fully green on verification (`npm test -- backend/test/sync-inbox.test.ts` → 4 passed; `npm test -- frontend/test/email-grid.test.ts` → 1 passed; full `npm test` → 33 passed; lint and frontend build clean). All five tests cover the seven acceptance cases; scope timestamps show only T5 files touched in the final round; no `$filter`, mailbox writes or scoring introduced.

However, `frontend/src/App.tsx` still renders only the T1 health-check placeholder. `Mail.tsx` (with Navbar, sync chip and grid) is never mounted, so the ticket's stated user-visible outcome — sign in, sync, see cached rows — is not reachable in the running app. `App.tsx` is owned by **T1** (`T1-scaffold-config-health.md`) and appears in no other ticket's allowed files, so T5 cannot fix it.

**Owner approved a standing integration lane** (see "Integration lane" charter above), which supersedes case-by-case escalation for composition-root seams. **Q23 resolved:** lane worker limited to `frontend/src/App.tsx` replaced the placeholder shell with `<Mail />`; verified 33/33 suite, lint and frontend build clean, only `App.tsx` touched. T5 accepted.

## T4 verification — two escalations (22 Nov 2026)

Verified: `npm test -- backend/test/db.test.ts` → 3 passed; full `npm test` → 16 passed; scope limited to the two allowed files; frozen migration untouched (only the previously approved header change); no `VACUUM`, no writes outside `db.ts`/test, `ON CONFLICT ... DO UPDATE` used, UTC ISO dates.

- **Q17 — runtime `schema_migrations` ledger — RESOLVED.** Owner accepted the runtime ledger; no frozen schema or migration file was changed.
- **Q18 — startup wiring blocker — RESOLVED.** Owner authorised a one-off wiring worker limited to `backend/src/server.ts`. Worker dispatched; T4 will be accepted after verification that startup opens the database, health still responds, and shutdown closes it.

## Q16 — resolved: Milestone 1 dependencies vs ticket allowed files

`backend/package.json` currently declares only dotenv, express, helmet and zod. T4 requires `better-sqlite3` but T4's allowed files are only `backend/src/db/db.ts` and `backend/test/db.test.ts`; no package manifest is allowed. The same gap will hit T2 (`@azure/msal-node`, `@azure/msal-node-extensions`, `express-session`), T3/T5/T6/T9 (`msw`), T8 (`dompurify`), and the frontend tickets (`ag-grid-community`, MUI, TanStack Query, etc.). Installing with `--no-save` would leave the build unreproducible on a clean checkout.

Recommendation: authorise one one-off dependency worker (same model, no parallel work) to add **all Milestone 1 dependencies** from spec §3 to `backend/package.json` and `frontend/package.json` now, before T4 is dispatched. Alternative: expand each ticket's allowed files to include the manifest it needs. **Owner answered: "yes do the recommendation" — one-off dependency worker dispatched on `coarena/gpt-6-luna`; Q16 resolved and verified: test 13/13, lint, build, `npm ls --depth=0` all clean.**

