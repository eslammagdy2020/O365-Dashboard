# Office 365 Command Center

A local-only Office 365 mailbox command center. Milestone 1 includes Entra sign-in, Microsoft Graph mailbox access, local message caching, and a loopback-only frontend and backend.

## Requirements

- Node.js 22 LTS or newer
- Windows 10 or 11 (the app applies Windows ACLs to its data directory)

## Setup and commands

From the repository root, install dependencies and create `backend/.env` from `backend/.env.example`. Set `SESSION_SECRET` to a random value of at least 32 characters, and configure `TENANT_ID` and `CLIENT_ID` for the Entra app registration before signing in.

```sh
npm install
npm run dev
npm test
npm run lint
npm run build
npm start
```

During development, open Vite at <http://localhost:5173> (the default `FRONTEND_URL`), and use <http://localhost:5000/api/health> for the backend health check. Both servers bind to loopback only. Vite proxies `/api` and `/auth` requests to the backend. For a production-style local run, `npm run build` followed by `npm start` serves the built frontend at <http://localhost:5000>; set `FRONTEND_URL=http://localhost:5000` in `backend/.env` and restart the backend for redirects and mutating requests to work.

## Local data and privacy

Persistent application data defaults to `%LOCALAPPDATA%\o365-command-center`. Set `DATA_DIR` in `backend/.env` to move the database, token cache, and logs together. On startup, the application creates this directory and restricts it to the current Windows user and SYSTEM. Message metadata in the SQLite database is stored in plain text; enable **BitLocker** on the drive containing this directory.

Never commit `.env` files or the contents of the data directory.

## Manual live-tenant checklist

For an owner-run check against a development tenant (not part of automated tests):

- [ ] Sign in and confirm the app shows the authenticated account without exposing tokens.
- [ ] Complete the initial Inbox, Sent Items and Archive sync; confirm progress and cached rows.
- [ ] Make a harmless message edit in Outlook and confirm it appears in the local cache within 2 minutes.
- [ ] Run an incremental sync and confirm it uses the saved delta state.
- [ ] Verify token expiry recovers through silent authentication, or pauses sync with a sign-in warning when interaction is required.
- [ ] Verify a Conditional Access/MFA requirement displays the prompt and sync resumes after the owner completes it.

Automated tests use MSW Graph mocks only; they never call live Graph or write to a live mailbox. The checklist is documentation for the owner and was not run by this ticket.

## 50k read-cache performance

`npm run perf` seeds a deterministic 50,000-message SQLite cache (60% Inbox, 30% Sent Items, 10% other; 255-character previews; 5,000 distinct senders), warms each query, then reports p95 for the real message-list controller's received-date page and FTS search queries. The fixture uses an in-memory database, so it leaves no benchmark database files behind.

Measured in this implementation run on the available Windows environment: **received-date page p95 10.67 ms; FTS search p95 9.89 ms** (40 samples per query after 5 warm-ups; 50k rows). This is below the 200 ms target, but the environment was not verified to match the reference Windows 11 / 4-core / 16 GB / SSD specification. Re-run `npm run perf` on the reference machine for its recorded result. The by-score index exists in the frozen schema, but scores are null in Milestone 1; a meaningful by-score benchmark is deferred until scoring lands in Milestone 2.
