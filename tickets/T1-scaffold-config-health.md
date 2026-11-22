# T1: Scaffold, config & health

**Status:** ready-for-agent

**Goal:** Get a runnable, testable skeleton: both apps start on loopback with strict TypeScript, config is validated at startup, all file paths derive from one `DATA_DIR`, and a health endpoint answers. This is the first rung of the dependency ladder; nothing else can start until it lands.

**Depends on:** T0 (read the frozen contracts before creating config/types).

**Allowed files** (paths relative to `o365-command-center/`):
- `package.json`, `backend/package.json`, `frontend/package.json`, `.gitignore`
- `tsconfig.json`, `backend/tsconfig.json`, `frontend/tsconfig.json`
- `eslint.config.js`, `.prettierrc`
- `backend/src/config/env.ts`, `backend/src/config/paths.ts`
- `backend/src/app.ts`, `backend/src/server.ts`
- `backend/src/routes/healthRoutes.ts`, `backend/src/controllers/healthController.ts`
- `backend/.env.example`, `README.md`
- `frontend/index.html`, `frontend/vite.config.ts`, `frontend/src/main.tsx`, `frontend/src/App.tsx`
- `backend/test/health.test.ts`

**Non-goals:**
- No auth, Graph calls, database tables, sync, scoring or mailbox writes.
- Do not edit `backend/src/db/migrations/001_init.sql` or `backend/src/graph/types.ts` (frozen in T0).
- Do not mount routes belonging to later tickets; leave a single registration point for them.

**What to build (user-visible):** `npm run dev` serves the backend and Vite together; `GET /api/health` returns 200; `npm test` and `npm run lint` pass on a clean checkout.

**Acceptance criteria / test cases:**
- npm workspaces for `backend` and `frontend`; TypeScript strict on both sides; ESLint + Prettier configured; vitest + supertest wired.
- `env.ts` loads `.env` and refuses to start when `SESSION_SECRET` is missing or shorter than 32 characters — no default. Loads `TENANT_ID`, `CLIENT_ID`, `REDIRECT_URI`, `FRONTEND_URL`, `PORT`, `HOST`, `DATA_DIR`, `LOG_LEVEL`, `AI_ENABLED`. `CLIENT_SECRET` is not required in this milestone.
- `paths.ts` is the only place that derives file locations: database `<DATA_DIR>/data.sqlite`, token cache `<DATA_DIR>/token-cache.bin`, logs inside `<DATA_DIR>`. `DATA_DIR` defaults to `%LOCALAPPDATA%/o365-command-center`. No other module hard-codes a path.
- First run creates `DATA_DIR` and restricts it with `icacls` — remove inheritance, grant full control only to the current user and SYSTEM.
- `server.ts` binds to `127.0.0.1` only; `vite.config.ts` binds to `127.0.0.1` and proxies `/api` and `/auth` to port 5000. Helmet and a CSP are installed.
- `.gitignore` covers `.env`, the token cache, the SQLite file plus `-wal`/`-shm`, logs, `node_modules` and `dist`.
- `README.md` documents dev/build/test commands, the `DATA_DIR` location and a recommendation to enable BitLocker because message metadata is stored in plain text.
- Test: health endpoint returns 200; config rejects absent and 31-character secrets; all derived paths move together when `DATA_DIR` is overridden.

**Test command:** `npm test -- backend/test/health.test.ts && npm run lint`
