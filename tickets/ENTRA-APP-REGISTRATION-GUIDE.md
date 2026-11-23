# Entra app registration guide (owner manual step)

For the Office 365 Command Center, Milestone 1. The orchestrator and workers do **not** perform these steps and never receive credentials. Automated tests use `msw` mocks; only you run the live checks below.

## Before you start

- Tenant consent: you confirmed in spec §20 that this app registration and user consent are allowed. If the tenant blocks user consent, an admin must grant the three delegated permissions below.
- OS target: Windows 10 or 11. Backend binds to `127.0.0.1` only.
- You will need the app to be running locally at `http://localhost:5000/auth/callback` and the frontend at `http://localhost:5173`.

## 1. Register the app

1. Go to **Entra admin center → App registrations → New registration**.
2. Name: `O365 Command Center`.
3. Supported account types: **Accounts in this organizational directory only** (single tenant).
4. Leave the redirect URI blank here; add it in step 2.

## 2. Add the redirect URI (public client — no secret)

1. **Authentication → Add a platform → Mobile and desktop applications**.
2. Add custom redirect URI: `http://localhost:5000/auth/callback`.
3. This makes it a **public client**, so there is **no client secret**. Keep PKCE.
4. *Fallback only:* if Entra rejects the public-client setup, register the **Web** platform instead, create a client secret, and tell the orchestrator so the fallback is recorded in `DECISIONS.md`. The config loader must then require `CLIENT_SECRET`. PKCE, token cache, scopes and session design stay the same.

## 3. Grant exactly three delegated permissions

**API permissions → Add a permission → Microsoft Graph → Delegated permissions:**

- `User.Read`
- `Mail.ReadWrite`
- `offline_access` (MSAL also adds this implicitly; it must still be consented)

Do **not** add any other permission. If user consent is blocked, ask the tenant admin to grant admin consent for these three only. Note: the app requests `Mail.ReadWrite` because the frozen spec mandates that scope; Milestone 1 performs **read-only** operations and never writes to the mailbox.

## 4. Copy IDs and create `backend/.env`

From the app's **Overview** page copy the **Application (client) ID** and **Directory (tenant) ID** into `o365-command-center/backend/.env`:

```env
TENANT_ID=<Directory (tenant) ID>
CLIENT_ID=<Application (client) ID>
REDIRECT_URI=http://localhost:5000/auth/callback
FRONTEND_URL=http://localhost:5173
SESSION_SECRET=<a random string of at least 32 characters>
PORT=5000
HOST=127.0.0.1
DATA_DIR=
LOG_LEVEL=info
AI_ENABLED=false
```

- `SESSION_SECRET` has **no default**; the app refuses to start if it is missing or shorter than 32 characters. Generate a random value (for example with a password manager).
- Leave `DATA_DIR` empty to use `%LOCALAPPDATA%\o365-command-center`. Everything (SQLite database, WAL/SHM, DPAPI token cache, logs) lives there.
- Never commit `.env`; it is git-ignored. For the production build (`npm run build` then `npm start`), set `FRONTEND_URL=http://localhost:5000`.
- Single-mailbox rule: the app stores the signed-in user's object id and refuses a different user until you purge local data. Sign in with the account you intend to use.

## 5. Verify the live flow (manual)

1. Run `npm run dev`, open `http://localhost:5173`, click **Sign in**.
2. Consent to the three permissions; the browser returns to the app showing your display name.
3. Restart the backend; you should remain signed in (SQLite-backed session, `SameSite=Lax` cookie, 12-hour lifetime).
4. Confirm a `POST /api/sync/run` starts sync and `/api/sync/status` reports progress.
5. Sign out; the session is cleared and the account is removed from the DPAPI token cache. Local cached data stays unless purged.
6. Later, during T9, run the README live-tenant checklist: incremental sync, token expiry, Conditional Access prompt, and an edit in Outlook appearing locally within 2 minutes.

## Troubleshooting

- **Redirect URI mismatch** — the URI must be exactly `http://localhost:5000/auth/callback` (platform: Mobile and desktop).
- **Login fails after the Entra redirect** — the cookie is `SameSite=Lax` by design (Strict drops it on the cross-site callback); confirm you are on `localhost`, not a LAN address or custom hostname.
- **Consent denied by policy** — ask the tenant admin to grant the three delegated permissions.
- **A different user signs in** — the single-mailbox rule refuses it until local data is purged; use the original account.

## Decisions from spec §20 relevant to your setup

- Tenant consent: allowed.
- Timezone: GMT+2 Cairo; business hours 09:00–17:00.
- Sync window: 90-day default; Archive folder does **not** exist in your mailbox — T7 will surface a persistent warning and skip it rather than fail.
- AI provider: none approved; `AI_ENABLED=false`.
- VIP senders: "addresses" (actual addresses/group names still to be supplied — needed only for Milestone 2 scoring).
- Auto category writes to Outlook: assume **no** (Milestone 1 performs no writes).
