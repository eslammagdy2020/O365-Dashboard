# T4: Local mailbox database bootstrap & FTS

**Status:** ready-for-agent

**Goal:** The app starts with a correctly initialised SQLite cache: WAL mode, the frozen schema applied by migration, and a full-text index that tracks subject and sender edits. This is a prefactor that lets sync write rows without worrying about storage mechanics.

**Depends on:** T1 (config, `DATA_DIR`, path derivation).

**Allowed files** (paths relative to `o365-command-center/`):
- `backend/src/db/db.ts`
- `backend/test/db.test.ts`

**Non-goals:**
- Do not create, edit or delete `backend/src/db/migrations/001_init.sql` — it is frozen in T0. Apply it as-is.
- No API routes, no sync logic, no scoring, no mailbox writes.
- No `VACUUM` — it can renumber rowids and desync the FTS index.

**What to build (user-visible):** Starting the backend creates `<DATA_DIR>/data.sqlite` with all tables ready; from this point on, message upserts keep the search index correct automatically.

**Acceptance criteria / test cases:**
- `db.ts` opens `<DATA_DIR>/data.sqlite` through `paths.ts` with better-sqlite3 in WAL mode and applies numbered migrations from `backend/src/db/migrations/` at startup, recording which have run so startup is idempotent.
- Dates written to the database are UTC ISO-8601. All SQL is parameterised.
- After any migration that touches existing rows, run `INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`.
- Message writes use `INSERT ... ON CONFLICT(id) DO UPDATE` only — never `INSERT OR REPLACE` — so the update trigger fires.
- Test: a fresh database has every table, index, FTS table and the three triggers from the frozen migration.
- Test: insert a message, search FTS, update its `subject` and `from_address`, search again — the old terms no longer match and the new ones do.
- Test: a delete removes the row from the FTS index; applying the migration twice leaves a usable database.

**Test command:** `npm test -- backend/test/db.test.ts`
