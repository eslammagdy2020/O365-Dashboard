# Office 365 Command Center: Build Specification

Version 1.3 · 24 November 2026 · Audience: AI coding agent, and the human reviewing its work

## 0. How to use this spec

- Build phase by phase (section 19). Do not start a phase until the previous phase's acceptance criteria pass.
- MUST means required. SHOULD means expected unless it causes a conflict. MAY means optional.
- Where the spec is silent, choose the simplest option and record it in DECISIONS.md. Do not add features that are not listed.
- Stop and ask the owner on anything in section 20.
- Never commit secrets. Never run automated tests that perform writes against a live mailbox.

## 1. Product summary

A local-only web app for one Microsoft 365 Business user. It signs in with Entra ID, mirrors the mailbox into a local SQLite database using Microsoft Graph delta queries, scores and categorizes messages, shows a daily dashboard, and is strictly read-only: it never changes the mailbox.

Goals: fast UI on 50,000+ cached messages, explainable priority scores, no mailbox writes, no tokens in the browser.

Non-goals: any mailbox write (move, archive, delete, flag, read state, categories), sending email, multi-user or hosted deployment, webhooks or any public URL, mobile, calendar or Teams integration, permanent deletion, Outlook add-in.

## 2. Corrections from the original plan

1. Auth was broken. The original mixed browser MSAL (user login) with a backend client-credentials flow (`.default` scope), which cannot call `/me/messages`. This spec uses delegated Authorization Code + PKCE, performed by the backend.
2. Removed unused permissions `Mail.Send` and `MailboxSettings.Read`. In v1.3 `Mail.ReadWrite` is also replaced by `Mail.Read`.
3. Replaced `.top(100)` with a local cache filled by delta sync, with paging, throttling handling and `$batch`.
4. Added the fields scoring needs (`hasAttachments`, `flag`, `conversationId`, `toRecipients`, and others). The Size column is dropped: message size is not a default Graph property and delta queries cannot expand the extended property needed for it.
5. Scoring is null-safe, case-insensitive, configurable and explainable. The original read `email.sender`, but Graph returns `from.emailAddress.address`.
6. Waiting For Response is now computed from Sent Items and conversation threads. Approval keywords map to Action Required, not Waiting For Response.
7. Mailbox writes (move, delete, flag, read state, categories) are removed entirely in v1.3. See section 11.
8. Dependencies removed: `jsonwebtoken`, `cors`, `axios`, `@microsoft/microsoft-graph-client`, `@azure/msal-browser`, `@azure/msal-react`.
9. Department traffic needs directory data that requires extra permissions, so it becomes traffic by sender group (section 14).

History only, not requirements: where any review note below mentions mailbox writes, actions, undo or cleanup, v1.3 supersedes it.

Review pass, 20 November 2026 (v1.1): this version also applies the build-checklist review. Changes: a persistent SQLite session store (section 6), unfiltered delta sync because Graph caps a filtered delta at 5,000 messages (section 9), separate `base_score` and `score` with integer weights (section 10), a `conversation_state` table for dismissed waiting threads (section 8), response shapes (section 12.1), a 255-character AI input default (section 15), and a decisions list (section 21).

Review pass 3, 24 November 2026 (v1.3): the app is read-only. Removed the Actions section, the write endpoints, action log, undo, cleanup, Outlook category writes, the Phase 4 write work, and the Milestone 2 and deferred write contracts. `Mail.ReadWrite` becomes `Mail.Read`. Milestone 1 (login, read-only sync, resume, minimal grid) is unchanged and stays implemented.

Review pass 2, 21 November 2026 (v1.2): applies a second external review. Changes: session cookie `SameSite=Lax`, because Strict breaks the Entra callback (section 6); Host and Origin validation, Windows folder permissions and an exact purge contract (sections 6 and 16); an `effective_at` timestamp, Archive synced by default, transactional sync progress and sync-window changes (sections 8 and 9); category and undo writes that re-read Outlook state first (SUPERSEDED by v1.3: all mailbox writes are removed); Unicode-safe Arabic keyword matching, VIP subdomain rules and `setMinScore` combination (section 10); exact dashboard definitions and FTS escaping (section 12); AI configuration and recovery (section 15); a settings export in place of file-level database backup (section 8); and Windows 11 as the target.

## 3. Tech stack (fixed)

- Runtime: Node.js 22 LTS or newer. Primary target is Windows 11. Windows 10 22H2 left standard support in October 2025, so support it only if the owner has ESU. TypeScript in strict mode on both sides. If the owner prefers plain JavaScript, record it in DECISIONS.md and keep the same structure.
- Backend: Express, `@azure/msal-node`, `@azure/msal-node-extensions`, `better-sqlite3` (WAL mode, FTS5), `node-cron`, `zod`, `pino`, `dotenv`, `express-session`. Tests: `vitest`, `supertest`, `msw`.
- Graph access: a thin wrapper over built-in `fetch` (section 7).
- Frontend: React, Vite, MUI, `ag-grid-community` (Infinite Row Model), `recharts`, TanStack Query, `react-router`, `dompurify`. No MSAL in the browser.
- Tooling: npm workspaces, ESLint, Prettier, `concurrently`.

## 4. Repository layout

```text
o365-command-center/
├── package.json            (workspaces: backend, frontend)
├── README.md
├── DECISIONS.md
├── backend/
│   ├── src/
│   │   ├── server.ts
│   │   ├── app.ts
│   │   ├── config/        env.ts, paths.ts
│   │   ├── auth/          msalClient.ts, tokenCache.ts, authRoutes.ts, requireAuth.ts
│   │   ├── graph/         graphClient.ts, batch.ts, mailApi.ts, types.ts
│   │   ├── db/            db.ts, sessionStore.ts, migrations/001_init.sql, repositories/
│   │   ├── sync/          syncService.ts, deltaApplier.ts, scheduler.ts
│   │   ├── services/      priorityService.ts, categoryService.ts, rulesEngine.ts,
│   │   │                  waitingService.ts, analyticsService.ts
│   │   ├── ai/            llmProvider.ts, summarizer.ts   (phase 6)
│   │   ├── controllers/   mailController.ts, dashboardController.ts, ...
│   │   └── routes/        mailRoutes.ts, ...
│   ├── test/
│   └── .env.example
└── frontend/
    ├── src/
    │   ├── components/    Dashboard, EmailGrid, PriorityCard, ActionQueue, Navbar, Login
    │   ├── pages/         Home, PriorityInbox, Analytics, Settings
    │   ├── services/      ApiService.ts
    │   ├── App.tsx
    │   └── main.tsx
    └── vite.config.ts
```

## 5. Entra app registration (manual step for the owner)

1. Entra admin center, App registrations, New registration. Name: O365 Command Center. Account type: single tenant.
2. Authentication, Add a platform, Mobile and desktop applications, custom redirect URI `http://localhost:5000/auth/callback`. This makes it a public client, so there is no client secret.
3. API permissions, Microsoft Graph, Delegated: `User.Read`, `Mail.Read`, `offline_access`. Nothing else. If an earlier registration granted `Mail.ReadWrite`, remove that permission in Entra and sign in again so the stored consent and token cache carry only read access.
4. These delegated permissions normally need no admin consent. If the tenant blocks user consent, ask the tenant admin to grant it.
5. Copy the Application (client) ID and Directory (tenant) ID into `backend/.env`.

Fallback: if Entra rejects the public-client setup, register the Web platform instead, create a client secret, and switch to `ConfidentialClientApplication`. Deltas: register the redirect URI under Web rather than Mobile and desktop; add `CLIENT_SECRET` to `.env` and to the config loader (required only in this mode, never logged); keep PKCE, which confidential clients still support. The token cache, scopes and session design do not change. Record the switch in DECISIONS.md.

## 6. Authentication and session

- Flow: Authorization Code + PKCE, performed by the backend with msal-node. The browser never receives access or refresh tokens.
- `GET /auth/login`: create the PKCE verifier and challenge plus a random `state`, store them in the server session, redirect to the Entra authorize URL with scopes `User.Read` and `Mail.Read`, `prompt=select_account`. MSAL adds `offline_access` by itself, so do not pass it explicitly.
- `GET /auth/callback`: read `state` and the verifier from the session and delete both immediately, whether or not validation succeeds, so they work only once. Validate `state`, exchange the code, call `session.regenerate()`, store only the `homeAccountId` in the new session, and redirect to `FRONTEND_URL`.
- Token cache: persisted with msal-node-extensions (DPAPI on Windows) at `<DATA_DIR>/token-cache.bin`. Every Graph call gets its token via `acquireTokenSilent`.
- Session: `express-session` with a small SQLite-backed store (`db/sessionStore.ts`, table `sessions`), so a restart keeps the user signed in. The cookie is httpOnly, lasts 12 hours, is signed with `SESSION_SECRET`, and uses `SameSite=Lax`, not Strict: Entra returns the browser to `/auth/callback` through a cross-site redirect, a Strict cookie is not sent on it, and login would fail because `state` and the verifier are lost. Use `secure: false` on `http://localhost`, and `secure: true` if the app ever moves to HTTPS. The session holds only the `homeAccountId`.
- `requireAuth`: return 401 `login_required` when there is no session or silent acquisition fails with `interaction_required` or `invalid_grant`. If the error carries a claims challenge (Conditional Access or MFA), return it so the next `/auth/login` passes `claims` through.
- Background sync uses the cached account via `acquireTokenSilent`. If that fails, sync pauses and the status shows `login_required`.
- Single-mailbox rule: store the signed-in user's object id in settings. If a different user signs in, refuse until the owner runs Purge local data.
- `POST /auth/logout` clears the session and removes the account from the MSAL cache. Local data stays unless purged.
- Request protection: every request MUST carry a `Host` header whose hostname is `localhost` or `127.0.0.1` (port ignored), which blocks DNS rebinding. Every mutating request MUST also carry `X-Requested-With: occ` and an `Origin` header equal to the origin of `FRONTEND_URL`. Anything else gets 403. The server binds to `127.0.0.1` only, and no endpoint ever returns tokens or token-cache contents.

## 7. Graph access layer

Base URL `https://graph.microsoft.com/v1.0`. Every request sends `Authorization: Bearer`, `Prefer: IdType="ImmutableId"` (message ids then survive folder moves) and a `client-request-id`.

- Retries: on 429, 503 and 504 honor `Retry-After`, otherwise exponential backoff with jitter (1s, 2s, 4s and so on, max 6 attempts). On 401 call `acquireTokenSilent` with `forceRefresh: true` once and retry once; if it still fails, mark `login_required`. Other 4xx errors throw a typed `GraphError(status, code, requestId)` with no retry.
- Timeouts and shutdown: every request has a timeout (default 30 seconds, `GRAPH_TIMEOUT_MS`) and an `AbortController`. On shutdown or purge, abort all in-flight requests and stop the scheduler before closing the database.
- Concurrency: a global limiter of 4 in-flight requests. This is a conservative, configurable default: Outlook limits apply per app and per mailbox, and sub-requests inside a `$batch` still count toward them.
- Paging: a helper follows `@odata.nextLink` until `@odata.deltaLink` or the end of results. Follow `nextLink` and `deltaLink` URLs verbatim; never rebuild or edit them. Never rely on `$top` alone.
- `$batch`: optional, and only for GET sub-requests. At most 20 sub-requests per call and at most 2 concurrent batch calls. Parse every sub-response status individually and retry only the items that returned 429 or 5xx, for at most 3 passes per batch; items still failing after that are reported failed per item. Each sub-request carries its own `Prefer: IdType="ImmutableId"` header, because the header applies only to the request that carries it.
- Immutable IDs: send the header on every message call (delta and get). Folder IDs are already stable and need no header. Read-only guard: the Graph wrapper MUST send only GET requests (plus POST to `/$batch` whose sub-requests are all GET) and MUST throw on any other method or sub-request method. No code path may PATCH, PUT, POST (other than that batch), or DELETE against Graph.
- Persistent errors: when retries are exhausted, record the error in `sync_state.error` (for sync) and surface it in `/api/sync/status` `warnings` and the UI. A failed background job MUST NOT disappear silently.
- Message `$select`: `id,conversationId,subject,from,sender,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,importance,hasAttachments,flag,categories,bodyPreview,parentFolderId,inferenceClassification,isDraft,webLink`.
- Functions in `mailApi.ts`: `getMe`, `listFolders`, `getWellKnownFolder(name)`, `messagesDelta(folderId, deltaLinkOrNull)`, `getMessage(id)` (fresh state), `getMessageBody(id)`, `getConversationMessages(conversationId)` (`$filter=conversationId eq ...` on `/me/messages`; if Graph rejects it, for example with InefficientFilter, fall back to local data and mark the result unverified), `batch(requests)` (GET only).

## 8. Local database

SQLite file at `<DATA_DIR>/data.sqlite` (`DATA_DIR` defaults to `%LOCALAPPDATA%/o365-command-center`), WAL mode. Dates are stored as UTC ISO-8601. Migrations are numbered SQL files applied at startup.

```sql
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess_json TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE folders (id TEXT PRIMARY KEY, parent_id TEXT, display_name TEXT NOT NULL, well_known TEXT);
CREATE TABLE sync_state (folder_id TEXT PRIMARY KEY, delta_link TEXT, resume_link TEXT, window_days INTEGER,
  last_sync_at TEXT, last_full_sync_at TEXT, status TEXT, error TEXT);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, conversation_id TEXT, folder_id TEXT NOT NULL,
  subject TEXT, from_address TEXT, from_name TEXT, to_json TEXT, cc_json TEXT,
  received_at TEXT, sent_at TEXT, effective_at TEXT, is_read INTEGER, importance TEXT, has_attachments INTEGER,
  flag_status TEXT, categories_json TEXT, body_preview TEXT, inference_class TEXT,
  web_link TEXT, is_draft INTEGER, is_from_me INTEGER,
  base_score INTEGER, score INTEGER, score_breakdown_json TEXT,
  auto_categories_json TEXT, scored_at TEXT, last_seen_sync TEXT
);   -- base_score = pure section 10.2 factors; score = effective, after rules
CREATE INDEX ix_msg_folder_received ON messages(folder_id, received_at DESC);
CREATE INDEX ix_msg_conv ON messages(conversation_id, effective_at);
CREATE INDEX ix_msg_unread ON messages(is_read, received_at);
CREATE INDEX ix_msg_score ON messages(score DESC);
CREATE INDEX ix_msg_from ON messages(from_address);
CREATE VIRTUAL TABLE messages_fts USING fts5(subject, from_address, from_name, body_preview,
  content=messages, content_rowid=rowid);
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, from_address, from_name, body_preview)
  VALUES (new.rowid, new.subject, new.from_address, new.from_name, new.body_preview);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_address, from_name, body_preview)
  VALUES ('delete', old.rowid, old.subject, old.from_address, old.from_name, old.body_preview);
END;
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_address, from_name, body_preview)
  VALUES ('delete', old.rowid, old.subject, old.from_address, old.from_name, old.body_preview);
  INSERT INTO messages_fts(rowid, subject, from_address, from_name, body_preview)
  VALUES (new.rowid, new.subject, new.from_address, new.from_name, new.body_preview);
END;
CREATE TABLE conversation_state (conversation_id TEXT PRIMARY KEY,
  dismissed_waiting INTEGER NOT NULL DEFAULT 0, dismissed_at TEXT, last_message_id TEXT);
CREATE TABLE vip (id INTEGER PRIMARY KEY, pattern TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
  label TEXT, group_name TEXT);   -- kind: address | domain
CREATE TABLE rules (id INTEGER PRIMARY KEY, name TEXT, position INTEGER, enabled INTEGER,
  conditions_json TEXT, actions_json TEXT);
CREATE TABLE ai_results (message_id TEXT PRIMARY KEY, content_hash TEXT, model TEXT,
  result_json TEXT, created_at TEXT);
```

`is_from_me` is computed at ingest by comparing the lowercased `from_address` with the `mail` and `userPrincipalName` returned by `getMe`. Mail sent from other aliases can be misclassified; this is accepted for v1. Message bodies are never stored, only `body_preview`.

FTS rules: write messages only with `INSERT ... ON CONFLICT(id) DO UPDATE`, never `INSERT OR REPLACE`, so the update trigger fires and the index follows subject and sender changes. Run `INSERT INTO messages_fts(messages_fts) VALUES('rebuild')` after any migration that touches existing rows. Never run `VACUUM`, which can renumber rowids and desync the index.

Retention: an hourly job deletes expired `sessions` and deletes `ai_results` older than 90 days.

Backup: the mailbox cache can be rebuilt by a resync, so it needs no backup. What cannot be rebuilt is VIPs, rules, scoring settings and dismissals. `POST /api/data/export` returns those as one JSON file and `POST /api/data/import` restores them, validated with zod. For a file-level backup use the SQLite online backup API (`db.backup()` in better-sqlite3) through `npm run backup`, never a plain copy of the `.sqlite` file while WAL mode is active. A test MUST export, purge, import and compare.

## 9. Sync engine

- Folders in scope: Inbox, Sent Items and Archive (Archive is needed so that archived replies still count in conversations). Deleted Items is optional, off by default.
- Effective date: every message gets `effective_at`, which is `sentDateTime` when `is_from_me` and `receivedDateTime` otherwise. It drives the sync window, conversation order, Waiting logic, response-time analytics and retention. `received_at` stays for display and for the Inbox date column.
- Initial sync runs an unfiltered delta per folder: `/me/mailFolders/{id}/messages/delta` with the `$select` above and `Prefer: odata.maxpagesize=50`. Do not use `$filter`: Graph caps a filtered delta at 5,000 messages. `$orderby=receivedDateTime desc` MAY be added so the newest messages arrive first, but that is only a UX optimization: correctness MUST NOT depend on the order of delta results.
- Apply the window locally. Store only items whose `effective_at` falls inside `syncWindowDays` (30, 90, 365 or all, default 90), and delete stored rows that age out in the nightly job. Expect one request per 50 messages in the folder, so a 50,000-message first sync takes several minutes.
- Window changes: `sync_state.window_days` records the window each folder's delta was built with. Raising the setting clears every folder's `delta_link` and runs a full unfiltered resync, because an incremental delta never returns older messages; existing rows stay until the resync completes. Lowering it only runs the retention cleanup.
- Follow `@odata.nextLink` and `@odata.deltaLink` verbatim. Never rebuild, edit or log them. Apply each delta page and save the next `resume_link` (or the final `delta_link`) in the same SQLite transaction, so a crash never leaves applied rows without saved progress.
- Incremental sync runs every 60 seconds (minimum 30) and on `POST /api/sync/run`. Only one sync runs at a time (mutex).
- Items with `@removed` are deleted locally; others are upserted. Sync never overwrites local-only columns (scores, breakdown, auto categories, AI results). A message moved out of a synced folder arrives as removed there and as new in its destination; if the destination is not synced, it disappears locally. This limitation is documented in section 10.4.
- HTTP 410 (`syncStateNotFound` or `resyncRequired`): clear that folder's `delta_link`, run a full unfiltered resync, and delete rows not seen in it (`last_seen_sync`) only after it completes successfully.
- Failure handling: a failed run (expired authentication, throttling beyond the retry limit, network loss, invalid delta token) sets `sync_state.status` to error with the message, appears in `warnings` and a UI banner, and is retried on the next cycle. Recovery never requires deleting the database.
- After each cycle, rescore changed messages, run the rules engine, and update status. Scheduled jobs: hourly for time-based factors and the retention job (section 8), and a nightly full rescore at 00:05 local time.
- The UI MUST be usable during initial sync and show progress. `GET /api/sync/status` returns phase, folder, counts, `lastSuccessAt`, `lastError`, `nextRunAt`, `warnings`. Webhooks are out of scope; polling delta is the design.

## 10. Priority scoring and categorization

### 10.1 Input normalization

Before scoring, normalize: lowercase `from_address` (empty string if missing), subject and preview to empty string if null, plus `toMe`, `ccMe`, `flagStatus`, `inferenceClass`. Scoring MUST NOT throw on missing fields.

Keyword matching: normalize both the text and the keywords with NFKC and lowercase. For Arabic, also remove tatweel (U+0640) and diacritics (U+064B to U+065F), fold the alef variants (أ إ آ) to ا, and fold ى to ي. Match with a Unicode lookbehind and lookahead for any letter or digit (`\p{L}`, `\p{N}`, `u` flag) instead of an ASCII word boundary, which does not work for Arabic. Arabic keywords also match with the optional attached prefixes و, ف, ب, ل and the article ال. Arabic punctuation (، ؛ ؟) counts as a separator. A keyword family (urgency, approval) counts at most once per message: the subject weight if the subject matches, otherwise the preview weight if only the preview matches, never both.

VIP matching is case-insensitive. An `address` entry matches exactly. A `domain` entry matches that exact domain; it matches subdomains only when written as `*.example.com`, so `example.com` does not match `mail.example.com`.

### 10.2 Score

Score applies to Inbox messages that are not drafts. Two derived values are stored: `base_score` is the clamped (0 to 100) sum of the factors below, and `score` is the effective score after the rules in 10.3, clamped again. Both are recomputed from scratch on every rescore; nothing ever increments a stored score. All weights are integers, so no rounding is needed. Weights and keyword lists live in `settings.scoring` and are editable in the UI.

- Importance high +30, low -10.
- Unread +10.
- Has attachments +10.
- VIP match +50 (exact address or domain).
- Subject contains an urgency keyword (urgent, asap, critical, escalation, immediate) +20, counted once.
- Subject contains an approval keyword (approval, approve, review, signoff) +25, counted once.
- Keywords found only in the preview use their own integer weights: urgency +10, approval +12.
- Flagged +15.
- Unread for more than 48 hours +15.
- Addressed directly to me (in To, 5 recipients or fewer) +10. Only in Cc -5.
- `inferenceClassification = other` -15.

Tiers use `score`: critical 80 and above, high 60 to 79, medium 30 to 59, low below 30. Store `score_breakdown_json` as a list of `{factor, points}`, rule adjustments included, and show it in a tooltip.

### 10.3 Rules engine

A rule has `conditions` (all must match) and `actions`.

- Condition types: `senderIsVip`, `senderMatches`, `textContains[]`, `unreadOlderThanHours`, `hasAttachments`, `importance`, `folder`, `toMeDirectly`.
- Action types (local only, never written to Outlook): `addCategory`, `setMinScore`, `addScoreBonus`. The two score actions change only the effective `score`, never `base_score`, and are reapplied from scratch on every recompute.
- Combining score actions: sum the bonuses of all matching rules, then apply the highest `setMinScore` among them as a floor: `score = clamp(max(base_score + bonuses, highestMinScore), 0, 100)`. Rules never lower a score. The breakdown records each rule that contributed.
- Seed rules: (1) VIP sender in group Manager gives category Management and min score 60. (2) Urgency keywords give category Urgent. (3) Unread over 48 hours gives Action Required. (4) Approval keywords (approve, approval, review, signoff) give Action Required.
- `POST /api/rules/preview` returns match counts and a sample, with no writes.

### 10.4 Waiting For Response (computed, not keyword-based)

A conversation is waiting when its latest non-draft message across the synced folders (Inbox, Sent Items, Archive) is from me, has at least one recipient other than me, is older than `waitingThresholdHours` (default 48) by `effective_at`, is not an automatic reply (subject starting with Automatic reply), and is not dismissed. Dismissing sets `dismissed_waiting` in `conversation_state` and stores the conversation's latest message id in `last_message_id`. A dismissal applies only while that message is still the latest: any new message in the conversation, whether I sent it or someone replied, clears it. Also provide an Awaiting my reply view: latest message is from someone else, I am in To, and I have sent nothing later in the conversation.

Limitation: a reply that sits in a folder that is not synced, or that is older than the sync window, is invisible locally. Before showing a Waiting candidate, the backend SHOULD verify it with `getConversationMessages`; if that query is unavailable, show the candidate marked unverified. The UI help text MUST state this limitation.

### 10.5 Categories

- Managed set: Action Required, Waiting For Response, Urgent, Finance, HR, IT, Management, Customer, Vendor, Personal, Archive.
- Categories are stored locally in `auto_categories_json` and shown in the app only. The app never writes categories to Outlook, and there is no `writeAutoCategoriesToOutlook` setting. The `categories` field read from Graph is displayed as-is and is never modified.

## 11. Read-only guarantee (replaces the former Actions section)

- The app has no mailbox write actions: no move, archive, delete, flag, read or unread change, or category change. Nothing in this app sends email.
- The only Graph permissions are `User.Read`, `Mail.Read` and `offline_access` (section 5). Graph would reject writes even if code tried.
- The Graph wrapper enforces GET-only access (section 7), with one exception: POST to `/$batch` is allowed only when every inner sub-request is GET. Local changes (VIPs, rules, settings, dismissals, local categories) never reach Outlook.
- Mail is changed by the owner in Outlook itself. The app picks those changes up through delta sync.
- `webLink` is shown as an Open in Outlook link so the owner can act there.

## 12. REST API

All routes except `/auth/*` and `GET /api/health` require a session. JSON in and out. Validate every input with zod.

```text
GET  /auth/login | /auth/callback | /auth/me      POST /auth/logout
GET  /api/health
GET  /api/sync/status                              POST /api/sync/run
GET  /api/dashboard/summary?tz=
GET  /api/messages?view=&folder=&category=&minScore=&q=&sort=&order=&offset=&limit=
GET  /api/messages/{id}                            (fetches the body live from Graph)
GET  /api/folders
GET|PUT /api/vip        GET|PUT /api/rules       POST /api/rules/preview
GET|PUT /api/settings   POST /api/data/purge | export | import
GET  /api/analytics/{volume|senders|response-time|categories|priority-trend|groups}
```

Views: `inbox`, `priority`, `unread`, `flagged`, `vip`, `waiting`, `awaiting-me`, `unread48`, `attachments`, `today`. Pagination is offset and limit (max 200), sort is whitelisted to avoid SQL injection, and `q` uses FTS5 with the input escaped.

Search (`q`): treat user input as plain text, never as FTS5 syntax. Split on whitespace, strip FTS operators and punctuation, wrap each term in double quotes with any inner quotes doubled, add a trailing `*` to the last term only for prefix matching, and join the terms with AND. Text the user already wrapped in double quotes is a phrase match. Use the default `unicode61` tokenizer, which is Unicode-aware. An empty `q` skips FTS.

### 12.1 Response shapes

- Success: `{ data: <object> }`. List: `{ items: [...], total, offset, limit }`, where `total` is the full count for the current filters. AG Grid's infinite row model needs it to know the last row.
- Error: the HTTP status plus `{ error: { code, message, requestId? } }`. Codes: `login_required`, `forbidden`, `not_found`, `validation_error`, `throttled`, `graph_error`, `internal_error`.
- `GET /api/dashboard/summary` returns `{ data: { counts: { unread, priority, flagged, waiting, vip, unread48, attachments, today }, actionQueue: MessageRow[], topPriority: MessageRow[], dailyVolume: [{ date, count }] } }`.
- `GET /api/sync/status` returns `{ data: { phase, folder, counts, lastSuccessAt, lastError, nextRunAt, warnings: string[] } }`.
- `GET /api/messages/{id}` returns the same row plus `breakdown` and the raw `bodyHtml` from Graph. The browser sanitizes it (section 13).

The message row used by every list endpoint:

```ts
type MessageRow = {
  id: string; conversationId: string; folderId: string;
  subject: string; fromName: string; fromAddress: string;
  receivedAt: string;                      // UTC ISO-8601
  isRead: boolean; importance: 'low' | 'normal' | 'high';
  hasAttachments: boolean; flagStatus: 'notFlagged' | 'flagged' | 'complete';
  categories: string[]; autoCategories: string[];
  baseScore: number | null; score: number | null;
  tier: 'critical' | 'high' | 'medium' | 'low' | null;
  breakdown?: { factor: string; points: number }[];   // detail endpoint only
  bodyPreview: string; webLink: string;
};
```

### 12.2 Dashboard metric definitions

All metrics count Inbox messages that are not drafts (`folder_id` is the Inbox, `is_draft = 0`) unless stated. Day boundaries use the `tz` setting, converted to UTC.

- Unread: `is_read = 0`.
- Priority: `score >= 60 AND (is_read = 0 OR flag_status = 'flagged')`.
- Flagged: `flag_status = 'flagged'`.
- Waiting For Reply: the number of conversations that meet section 10.4, not messages.
- Manager/VIP unread: `is_read = 0` and the sender matches any VIP row under the matching rules in section 10.1.
- Unread over 48h: `is_read = 0 AND received_at < now - 48 hours`.
- With attachments: `has_attachments = 1 AND is_read = 0`.
- Today's emails: `received_at` on or after the start of today in the `tz` setting.

## 13. Frontend

- Navbar: Home, Priority Inbox, Analytics, Settings, a sync status chip (last sync time, progress, errors), Sign out.
- Login: one button that navigates to `/auth/login`. The app shows it on any 401 `login_required`.
- Home (Dashboard): eight metric cards, each linking to the matching grid view: Unread, Priority (Inbox, score 60 or more, and unread or flagged), Flagged, Waiting For Reply, Manager/VIP unread, Unread over 48h, With attachments (Inbox, unread), Today's emails. Below them: ActionQueue (top 10 by score among unread, flagged or waiting), PriorityCard list (top 5), and a small daily volume chart. Day boundaries use the `tz` setting.
- PriorityInbox: EmailGrid built on AG Grid's Infinite Row Model (page size 100, server-side sort and filter). Columns: Priority (colored score badge with breakdown tooltip), Sender, Subject, Received, Importance, Category, Attachment icon, Flag, Open in Outlook link. A toolbar offers view chips, category filter, min score, search box.
- Detail drawer: header, categories, body fetched on open and rendered in a sandboxed iframe without `allow-scripts`, sanitized with DOMPurify, remote images blocked until the owner clicks Load images, links open in a new tab with `noopener`, plus an Open in Outlook link from `webLink`.
- Settings: VIP and groups editor, rules editor with preview, scoring weights and keywords, sync window and interval, folders to sync, timezone and business hours, Purge local data.
- Behavior: error snackbars, loading skeletons, and stale data shown with a Last synced label when offline. Keyboard shortcuts (j and k to move) SHOULD be supported.

Body rendering (decision): the drawer renders the body with `srcDoc` in an iframe whose `sandbox` has no `allow-scripts`. DOMPurify runs first, and at sanitize time every `img src` and CSS `url()` that points to a remote host is rewritten to a `data-blocked-src` attribute. The iframe document carries its own CSP meta tag: `default-src 'none'; style-src 'unsafe-inline'; img-src data:`. Load images re-renders the `srcDoc` with the original URLs restored and `img-src data: https:`. A `srcdoc` iframe also inherits the app's CSP, so the app CSP allows `img-src 'self' data: https:`, and the blocking lives in the sanitizer and the iframe's own CSP.

Data freshness: every page shows when it was last synced. When the last sync failed, the app is offline or login is required, show a Cached data, not current banner, and never present cached rows as freshly synchronized.

## 14. Analytics

All charts come from local SQL, drawn with recharts, with a date range picker (default 30 days).

- Emails received by day.
- Top senders: top 15 by count, with unread count.
- Response time: for each inbound message whose conversation contains a later message sent by me, measure received time to my first later sent time. Show median and p90 per week and bucket counts (under 1 hour, 1 to 4 hours, 4 to 24 hours, over 24 hours). Calendar hours by default. Show a coverage note when the sync window is short.
- Category distribution, manual and auto.
- Priority trend: daily counts by tier, grouped by received date from current scores. Document this as an approximation.
- Traffic by sender group: groups come from `vip.group_name` or sender domain, with internal versus external split by tenant domain.

Response-time exclusions: ignore automatic replies (subject starting with Automatic reply) and messages I sent only to myself, the same exclusions section 10.4 uses for Waiting. Time ordering and response-time math use `effective_at`. UI copy for the priority trend must say it is based on current scores, and must never imply historical scoring.

## 15. AI features (phase 6, optional)

- Disabled unless `AI_ENABLED=true`. Use an `LlmProvider` interface (`complete(prompt, jsonSchema)`). The first implementation is Azure OpenAI, configured with `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION` and `AZURE_OPENAI_API_KEY` in `.env`. The key is never stored in SQLite, logged, or returned by any endpoint.
- The provider MUST be approved by the organization's data policy. Input is sender, subject and `body_preview`, which Graph truncates to about 255 characters; that is the v1 default. Reading the full body is an explicit opt-in setting (`aiReadFullBody`, off by default): the body is fetched on demand as text and never stored. The trade-off is better results against more mail content leaving the tenant and higher token cost. Attachments are never sent.
- Output is validated with zod: `summary` (max 40 words), `suggestedCategory` (from the managed set), `confidence` (0 to 1), `actionRequired` (boolean), `dueHint` (string or null).
- Results are cached by message id, content hash (a hash of sender, subject and the exact text sent) and model. If a message changes so that its hash changes, the old result is marked stale and hidden, and the message is requeued. Results older than 90 days are purged. Processing runs in a rate-limited background queue for new Inbox messages with a daily cap (default 500).
- Endpoints: `GET /api/ai/messages/{id}` (cached result or 404), `POST /api/ai/messages/{id}/analyze` (force a run), `GET /api/ai/digest` (latest digest), `POST /api/ai/digest/run`.
- Auto-apply only at confidence 0.85 or higher, to local categories. Categories are never written to Outlook. The UI shows confidence next to AI categories.
- Daily digest: generated at `digestTime` (default 07:30 local time) and stored in `settings` under `dailyDigest` with its date. If the app was closed at that time, the scheduler generates today's digest once, on the next start or tick after the time has passed, when none exists for today's local date.

## 16. Security and privacy

- Bind to `127.0.0.1` only: the backend and the Vite dev server, never the LAN. Validate Host and Origin as in section 6. Use helmet and a CSP (section 13 covers the body iframe). Never send tokens to the browser.
- Windows isolation: loopback is not user isolation. On first run create `DATA_DIR` and restrict its permissions with `icacls`, removing inheritance and granting full control only to the current user and SYSTEM. The database, WAL and SHM files, token cache and logs all live inside `DATA_DIR`. Keep the token cache DPAPI-protected.
- Never log subjects, bodies or addresses, and never log `nextLink` or `deltaLink` URLs (they carry opaque sync tokens), at any level. Log Graph request ids and error codes.
- `.env`, the token cache and the database are git-ignored. The README MUST recommend BitLocker, since the local database holds message metadata in plain text.
- Backup and retention follow section 8.
- Purge contract: `POST /api/data/purge` requires `confirmed: true` and returns 409 if a purge is already running. In order: stop the scheduler and abort in-flight sync and Graph requests; remove the account from the MSAL cache and delete the token cache file; destroy all sessions; close SQLite; delete the database, its WAL and SHM files, the logs and cached AI results; then create an empty database and return the app to the unauthenticated state.
- Validate all route inputs with zod and use parameterized SQL only.
- Request only the three delegated permissions in section 5.
- No endpoint ever returns token or token-cache contents.

## 17. Configuration and running

```env
TENANT_ID=
CLIENT_ID=
REDIRECT_URI=http://localhost:5000/auth/callback
FRONTEND_URL=http://localhost:5173
SESSION_SECRET=
PORT=5000
HOST=127.0.0.1
DATA_DIR=
LOG_LEVEL=info
AI_ENABLED=false
```

- `npm run dev` starts the backend and Vite together. Vite binds to 127.0.0.1, never the LAN, and proxies `/api` and `/auth` to port 5000.
- `npm run build` then `npm start` makes the backend serve `frontend/dist` at `http://localhost:5000`. In that mode set `FRONTEND_URL=http://localhost:5000`.
- `npm test` runs all tests. `npm run lint` runs ESLint.
- All file paths (database, token cache, logs) derive from `DATA_DIR` in `config/paths.ts`, which defaults to `%LOCALAPPDATA%/o365-command-center`. No other module hard-codes a path, so setting `DATA_DIR` moves everything together.
- The config loader MUST refuse to start when `SESSION_SECRET` is missing or shorter than 32 characters. There is no default. `CLIENT_SECRET` is required only in the confidential-client fallback (section 5).

## 18. Testing

- Unit tests: scoring (null subject, missing sender, VIP exact, domain and subdomain matching, keyword family counted once, clamping, recompute is idempotent), keyword engine (Arabic with diacritics and tatweel, Arabic punctuation, attached prefixes, mixed Arabic and English, a case where an ASCII word boundary would fail), rules engine (score actions never change `base_score`, two `setMinScore` rules), delta applier (add, update, `@removed`, 410 resync), retry and backoff (429 with Retry-After, 5xx, forced refresh after 401), waiting-for-reply logic (auto-replies, dismissal cleared by a new message), FTS escaping and phrase search, and the FTS index following subject and sender changes.
- Sync resilience tests (mocked Graph): restart during initial sync resumes; network drop; expired token; progress saved in the same transaction as each page; raising the sync window triggers a full resync while lowering it only cleans up; every failure appears in `warnings` and none needs a database reset.
- Security and read-only tests: wrong Host or Origin and a missing `X-Requested-With` are rejected; the OAuth callback works with a Lax cookie and a replayed `state` fails; the session id changes after login; no endpoint returns token-cache contents; purge removes the database, WAL and SHM files, token cache, sessions and logs; export, purge and import round-trips; the read-only guard throws on any Graph call that is not a GET, except POST to `/$batch` whose inner requests are all GET, and throws on a `$batch` with any non-GET inner request; no code path issues a Graph write.
- Integration tests with `msw` mocking Graph. No test may call live Graph.
- Performance: a synthetic dataset of 50,000 messages (60 percent Inbox, 30 percent Sent Items, 10 percent other, 255-character previews, 5,000 distinct senders). On a reference machine (Windows 11, 4 cores, 16 GB RAM, SSD), the p95 of grid page queries (by received date, by score, and an FTS search) MUST be under 200 ms.
- A manual live-tenant checklist in the README: login, initial sync, incremental sync, token expiry, Conditional Access prompt.

## 19. Phases and acceptance criteria

- Phase 0, scaffold: workspaces, lint, test runner, config loader, health endpoint. Done when `npm run dev` serves both apps and `npm test` passes.
- Phase 1, auth: login, callback, silent refresh, logout, DPAPI token cache, SQLite session store, Host and Origin checks. Done when a real login shows the user's name, a restart keeps the user signed in, the callback works with the Lax cookie, and `/api/*` returns 401 without a session.
- Phase 2, database and sync: migrations, initial and incremental delta sync, 410 recovery, window changes, status endpoint. Done when, on the synthetic 50,000-message dataset, the initial sync shows progress, resumes after an interruption and meets the query target; the sync resilience tests pass; and on a live tenant, login and sync work and an edit made in Outlook appears locally within 2 minutes.
- Phase 3, scoring, read API, dashboard and grid: scoring, rules engine, waiting logic, messages and dashboard endpoints, Home and PriorityInbox pages. Done when all eight cards match the section 12.2 definitions against direct SQL counts and scoring and keyword tests pass.
- Phase 4, read-only enforcement (replaces the former write phase): the GET-only Graph guard (with the GET-only `/$batch` exception) and its tests. Done when the guard tests pass and a code search finds no Graph PATCH, PUT, DELETE, or POST other than a GET-only `/$batch`.
- Phase 5, analytics and settings: all charts, VIP and rules editors, settings, export and import, purge. Done when every chart renders on the 50k dataset, settings changes alter scores after the next recompute, and the purge and export round-trip tests pass.
- Phase 6, AI (optional): provider, cache, queue, digest. Done when results validate against the schema, the daily cap is enforced, and a missed digest is generated on the next start.

## 20. Open questions for the owner

Stop and ask, or record an assumption in DECISIONS.md, for each of these:

1. Does the tenant allow this app registration and user consent (section 5)? a- YES
2. Who are the Manager and VIP senders (addresses or domains, with group names)? a- adresses
3. Removed in v1.3: the app never writes to the mailbox, so categories stay local. (Earlier answer: no.)
4. Timezone and business hours for dashboard days and response-time stats?. a- timezone (GMT+2)Cairo and Business hours are from 9 to 5
5. Sync window (default 90 days) and whether Deleted Items is synced (Archive is synced by default). a- YES
6. Is an AI provider approved for mail content, and which one? a- No
7. Does the mailbox have an Archive folder (section 9)? a- Yes
8. Is Windows 11 the deployment OS, or is Windows 10 covered by ESU? a- windows 10 and 11

## 21. Decisions from the 20 November review

These answer review questions Q8 to Q12. Historical record: any mention of writes or actions in these lists is superseded by v1.3. Change them only with the owner.

1. `DATA_DIR` moves everything: the database, token cache and logs.
2. Sessions persist in SQLite (section 6), not rehydrated from the MSAL cache.
3. A new message in a conversation clears its Waiting dismissal (section 10.4).
4. Categories are local only and never written to Outlook (section 10.5).
5. AI uses the roughly 255-character preview by default. Full-body reading is an opt-in setting (section 15).

From the 21 November review (v1.2):

1. The session cookie is `SameSite=Lax`, so the Entra callback keeps `state` and the PKCE verifier.
2. `$orderby=receivedDateTime desc` is an optional UX optimization; correctness never depends on delta order.
3. `effective_at` (sent time for my messages, received time otherwise) drives the window, conversations and response times. Archive is synced by default.
4. The mailbox cache is not backed up, because it is rebuildable. VIPs, rules, settings and dismissals are exported as JSON instead.
5. Host and Origin validation and `DATA_DIR` permissions replace the assumption that loopback isolates Windows users.
6. Windows 10 and 11 is the target OS.

From the 24 November review (v1.3):

1. The app is read-only. No mailbox writes exist in any milestone, and `Mail.Read` replaces `Mail.ReadWrite`.
2. The Actions section, write endpoints, action log, undo and cleanup are removed.
---

**Appendix A: Safety Contracts (Milestone 1)**

**A1. Sync removal is conditional.**
- When a delta reports a message as removed from folder F, delete the local row only if its current folder is F.
- If the row's folder is different (for example, Archive synced the move first), ignore the removal.
- Omitted delta fields must keep their cached values. Never overwrite with null or defaults.
- Tests: Inbox-removal-first and Archive-added-first orders, plus duplicate replay of each. The final state must be identical in all cases.

**A2. Batches count inner requests.**
- Each batch of up to 4 inner requests counts as 4 operations against the concurrency limit.
- Batches share one limiter with ordinary sync and detail calls.
- Honor Retry-After on each subresponse, not just on the batch response.
- Test: a batch with one throttled subresponse delays only the retry of that request.

**Appendix B: Milestone 1 scope (implemented)**

In scope: login → read-only sync → restart/resume → minimal grid.

Milestone 2 (the former write milestone) is cancelled. No milestone adds mailbox writes: no moves, deletes, flags, categories or bulk actions.

**Appendix C: Deferred write contracts (removed in v1.3)**

These contracts covered category writes, exact-message confirmation, crash safety for writes and write rollout. They are removed because the app has no write code.

**Spec status:** frozen after the v1.3 read-only patch. Milestone 1 stays implemented. Further changes only in response to a failure found while building.
