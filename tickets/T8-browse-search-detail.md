# T8: Browse, search & read safely

**Status:** ready-for-agent

**Goal:** Turn the minimal grid into a pleasant, safe read-only inbox: filters, server-side paging and sort, fast escaping-safe search, and a detail drawer that renders remote HTML without letting it script the app.

**Depends on:** T5 (can run in parallel with T6/T7).

**Allowed files** (paths relative to `o365-command-center/`):
- `backend/src/routes/messageRoutes.ts`, `backend/src/controllers/messageController.ts`
- `frontend/src/pages/Mail.tsx`, `frontend/src/components/EmailGrid.tsx`
- `frontend/src/components/MessageDetailDrawer.tsx`, `frontend/src/components/CachedDataBanner.tsx`
- `frontend/src/services/ApiService.ts`
- `backend/test/messages-api.test.ts`, `frontend/test/body-sanitizer.test.ts`

**Non-goals:**
- No writes: no categorise, flag, read/unread, move, archive, delete or bulk actions; no `e` / `u` keyboard shortcuts (those are writes). `j`/`k` row navigation MAY be added.
- No scoring tiers, priority view, waiting views or dashboard cards — those need services deferred to Milestone 2.
- Do not edit schema/migrations or frozen Graph types.

**What to build (user-visible):** The user can filter to unread/flagged/attachments/today, search by text or phrase, page and sort the grid, and open a message whose body is rendered safely with remote images held back until explicitly allowed. When sync failed or login is required, cached rows are clearly labelled as stale.

**Acceptance criteria / test cases:**
- Views supported in this milestone: `inbox`, `unread`, `flagged`, `attachments`, `today`, `unread48`. `priority`, `waiting`, `awaiting-me` and `vip` are deferred. Offset/limit with max 200; sort whitelisted to avoid SQL injection; `total` is the full count for the current filters.
- Search `q`: treat input as plain text, never FTS5 syntax. Split on whitespace, strip FTS operators and punctuation, wrap each term in double quotes with inner quotes doubled, add a trailing `*` to the last term only, join with AND; preserve text the user wrapped in quotes as a phrase; use the `unicode61` tokenizer; an empty `q` skips FTS. Test an injection-style query and a phrase query.
- `GET /api/messages/{id}` fetches the body live from Graph and returns the frozen `MessageRow` plus `breakdown` (null in this milestone) and raw `bodyHtml`.
- Drawer rendering: DOMPurify first; at sanitize time rewrite every remote `img src` and CSS `url()` to `data-blocked-src`; render via `srcDoc` in an iframe whose `sandbox` has no `allow-scripts` and whose own CSP meta tag is `default-src 'none'; style-src 'unsafe-inline'; img-src data:`. "Load images" re-renders with original URLs restored and `img-src data: https:`. Links open in a new tab with `noopener`; an Open in Outlook link uses `webLink`. The app CSP allows `img-src 'self' data: https:`.
- Every page shows the last-synced time; when the last sync failed, the app is offline or login is required, show a "Cached data, not current" banner and never present cached rows as freshly synchronised.
- Tests: FTS escaping/phrase, FTS index follows subject/sender changes, sort whitelist, detail response shape, sanitizer removes scripts and blocks remote images until opted in, stale-data banner appears on a failed sync.

**Test command:** `npm test -- backend/test/messages-api.test.ts && npm test -- frontend/test/body-sanitizer.test.ts`
