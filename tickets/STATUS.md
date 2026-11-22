# Milestone 1 — Build Status

Spec: `Office 365 Command Center Build Specification.md` (frozen)
Brief: `orchestrator.md`
Dispatch gate: **NOT APPROVED** — T0 owner confirmation + orchestrator approval still required.
Worker model requested: `coarena/gpt-6-luna` ("GPT-6 Luna Coarena (free)") — awaiting owner confirmation of the exact ID.

## Dependency graph (from ticket "Depends on" fields)

```text
T0 (owner-owned, not dispatched)
└── T1  Scaffold, config & health
    ├── T2  Entra sign-in with a persistent session
    │   └── T3  Resilient Graph read client & folders API
    │       └── T5  First inbox rows in a minimal grid
    │           ├── T6  Restart, resume & recovery
    │           │   └── T7  All in-scope folders, window changes & scheduled sync
    │           │       └── T9  50k performance & resilience verification
    │           ├── T8  Browse, search & read safely  ──┐
    │           │   (ticket says parallel with T6/T7)   │
    │           │                                       ├── T9
    │           └───────────────────────────────────────┘
    └── T4  Local mailbox database bootstrap & FTS
        └── T5
T9 → T10  Restart/resume integration test (dispatch only after T9 Done)
```

## Ticket table

| ID | Title | Depends on | Status | Attempts |
|----|-------|------------|--------|----------|
| T0 | Freeze contracts & safety invariants | — | FROZEN per ticket; awaiting owner confirmation; NOT dispatched | 0 |
| T1 | Scaffold, config & health | T0 | Blocked — awaiting T0 confirmation + dispatch approval | 0 |
| T2 | Entra sign-in with a persistent session | T1 | Blocked — T1 | 0 |
| T3 | Resilient Graph read client & folders API | T2 | Blocked — T2 | 0 |
| T4 | Local mailbox database bootstrap & FTS | T1 | Blocked — T1 | 0 |
| T5 | First inbox rows in a minimal grid | T3, T4 | Blocked — T3, T4 | 0 |
| T6 | Restart, resume & recovery | T5 | Blocked — T5 | 0 |
| T7 | All in-scope folders, window changes & scheduled sync | T6 | Blocked — T6 | 0 |
| T8 | Browse, search & read safely | T5 | Blocked — T5 | 0 |
| T9 | 50k performance & resilience verification | T7, T8 | Blocked — T7, T8 | 0 |
| T10 | Restart/resume integration test | T9 | Blocked — T9 (dispatch only after T9 Done) | 0 |

## Proposed dispatch order (subject to approval)

1. Owner confirms T0 contracts are frozen and provides their paths (no worker).
2. **T1** alone — establishes `package.json`, npm workspaces, paths, app skeleton.
3. **T2 + T4 in parallel** — allowed-file sets are disjoint (T2: auth/app/.env/test; T4: db.ts/test).
4. **T3** alone — depends on T2; shares `backend/src/app.ts`.
5. **T5** alone — depends on T3 + T4; large shared-file set (`app.ts`, sync routes, message routes, frontend).
6. **T6 + T8 in parallel** — allowed-file sets are disjoint (T6: syncService/deltaApplier/app.ts/sync-recovery test; T8: message API/frontend/body-sanitizer test).
7. **T7** — depends on T6; **cannot run in parallel with T8** because both list `frontend/src/pages/Mail.tsx`. Hold until T8 is Done if T8 is still running.
8. **T9** — depends on T7 + T8; tests + `package.json` perf script + README only.
9. **T10** — dispatched only after T9 is Done (per brief "Finish").

## Open blockers requiring owner decision (see chat / QUESTIONS.md)

- T0 artifacts do not yet exist under `E:\AI\O365` (no `o365-command-center/` directory); "paths to frozen contracts" cannot be given to a worker until confirmed.
- `E:\AI\O365` is not a git repository, so the mandated `git diff --name-only` verification is not yet possible.
- T0 lists a `contracts` test in its test cases and test command but omits `backend/test/contracts.test.ts` from its allowed files.
- T8 ticket text says it "can run in parallel with T6/T7", but T7 and T8 both list `frontend/src/pages/Mail.tsx` (overlap) — conflict with the orchestrator's parallel rule.
- Exact worker model ID and dispatch mechanism need confirmation (`coarena/gpt-6-luna` proposed; `general` subagent proposed).
- §20 owner questions / DECISIONS.md assumptions and Entra registration / credentials ownership need confirmation. No worker will receive live credentials.
