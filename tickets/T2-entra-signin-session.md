# T2: Entra sign-in with a persistent session

**Status:** ready-for-agent

**Goal:** A user can sign in with their Microsoft account and stay signed in across a backend restart; every other API is gated until then, and the loopback-only request protections are in place.

**Depends on:** T1.

**Allowed files** (paths relative to `o365-command-center/`):
- `backend/src/auth/msalClient.ts`, `tokenCache.ts`, `authRoutes.ts`, `requireAuth.ts`
- `backend/src/db/sessionStore.ts`
- `backend/src/app.ts` (register auth router and request-protection middleware — shared file; run sequentially with other tickets that list it)
- `backend/.env.example`
- `backend/test/auth.test.ts`

**Non-goals:**
- No mailbox reads or writes, no sync, no Graph calls beyond token acquisition.
- Do not edit schema/migrations or frozen `graph/types.ts`.
- No tokens or token-cache contents in any response or log; never log subjects, bodies or addresses.

**What to build (user-visible):** `/auth/login` redirects to Entra; after consent the browser lands on the app showing the user's name. Restarting the backend keeps the user signed in. Sign out clears the session. Unauthenticated `/api/*` calls get `401 login_required`.

**Acceptance criteria / test cases:**
- `msalClient.ts`: backend Authorization Code + PKCE with msal-node, public client (no client secret), scopes `User.Read` and `Mail.ReadWrite` only — `offline_access` is added by MSAL, `prompt=select_account`, and a claims challenge from `requireAuth` is forwarded through the next login.
- `GET /auth/login` stores verifier, challenge and a random `state` in the session and redirects to the Entra authorize URL. `GET /auth/callback` reads and deletes `state` and verifier immediately whether validation succeeds or not, validates `state`, redeems the code, calls `session.regenerate()`, stores only `homeAccountId` in the new session, then redirects to `FRONTEND_URL`.
- `tokenCache.ts`: msal-node-extensions DPAPI cache at `<DATA_DIR>/token-cache.bin`; `acquireTokenSilent` for every Graph token; logout removes the account from the cache.
- `sessionStore.ts`: express-session with a small SQLite store over the frozen `sessions` table; 12-hour httpOnly cookie signed with `SESSION_SECRET`, `SameSite=Lax` (Strict breaks the Entra callback), `secure: false` on localhost.
- `requireAuth.ts`: 401 `login_required` when there is no session or silent acquisition fails with `interaction_required` / `invalid_grant`; surface claims challenges for Conditional Access / MFA.
- Single-mailbox rule: store the signed-in user's object id in settings; refuse a different user until the owner purges local data.
- Request protection: every request must carry a `Host` whose hostname is `localhost` or `127.0.0.1` (port ignored). Every mutating request must also carry `X-Requested-With: occ` and an `Origin` equal to the origin of `FRONTEND_URL`. Anything else gets 403.
- Tests: login URL carries PKCE challenge and state; a replayed callback `state` fails; session id changes after login; a restart keeps the session; `/api/*` returns 401 without one; wrong Host, wrong Origin and missing `X-Requested-With` are rejected; the callback works with a Lax cookie; no endpoint returns token-cache contents.

**Test command:** `npm test -- backend/test/auth.test.ts`
