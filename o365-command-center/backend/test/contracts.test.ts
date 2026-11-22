/**
 * T0 verification. This test does NOT exercise runtime behaviour — it guards
 * the frozen artefacts so an accidental edit fails CI. Update it only when the
 * owner explicitly changes a frozen contract.
 *
 * Assumes the ESM setup T1 will configure (import.meta.url).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const readFrozen = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

const contract = readFrozen('../../docs/contracts/M1-frozen.md');
const migration = readFrozen('../src/db/migrations/001_init.sql');
const graphTypes = readFrozen('../src/graph/types.ts');

const expectAll = (text: string, needles: string[]): void => {
  for (const needle of needles) {
    expect(text, `frozen contract drift — missing: ${needle}`).toContain(needle);
  }
};

describe('T0 frozen contracts', () => {
  it('records owner confirmation of all three artefacts before dispatch', () => {
    expectAll(contract, [
      '- [x] Owner confirms this document is frozen.',
      '- [x] Owner confirms `001_init.sql` is frozen.',
      '- [x] Owner confirms `graph/types.ts` is frozen.',
      '- [x] Only after all three: dispatch T1.',
    ]);
  });

  it('freezes the Milestone 1 scope line', () => {
    expectAll(contract, [
      'Milestone 1 only',
      'login → read-only sync → restart/resume → minimal read-only grid',
      'No mailbox writes, no category writes, no bulk actions.',
      'No scoring, dashboard cards, analytics, settings editors or AI',
      'always null in Milestone 1',
    ]);
  });

  it('freezes the canonical row, response, error and sync-status shapes', () => {
    expectAll(contract, [
      'type MessageRow = {',
      'receivedAt: string;',
      'baseScore: number | null;',
      'score: number | null;',
      'tier:',
      'breakdown?: { factor: string; points: number }[];',
      'bodyPreview: string;',
      'webLink: string;',
      'type Success<T> = { data: T };',
      'type List<T> = { items: T[]; total: number; offset: number; limit: number };',
      'type ApiError = { error: { code: ErrorCode; message: string; requestId?: string } };',
      "'login_required'",
      "'confirmation_required'",
      "'draft_not_supported'",
      'type SyncStatus = {',
      'warnings: string[];',
      'type ActionResult = { id: string; ok: boolean; error?: string; noop?: boolean; conflict?: boolean };',
    ]);
  });

  it('freezes safety invariant A1 and its required test matrix', () => {
    expectAll(contract, [
      'Frozen safety invariant A1 — conditional sync removal',
      'delete the local row **only if**',
      'Omitted delta fields keep their cached values.',
      'last_seen_sync',
      'HTTP 410',
      'Inbox-removal-first',
      'Archive-added-first',
      'duplicate replay',
    ]);
  });

  it('freezes safety invariant A2 and its required test', () => {
    expectAll(contract, [
      'Frozen safety invariant A2 — batches count inner requests',
      'global concurrency limiter is **4**',
      'counts as **one**',
      'at most 20 sub-requests',
      'at most 2 concurrent batch calls',
      'on each sub-response, not just on the batch response.',
      'IdType="ImmutableId"',
      'measured concurrency never exceeds 4',
    ]);
  });

  it('freezes the whole schema, WAL mode, FTS table, indexes and triggers', () => {
    expectAll(migration, [
      'PRAGMA journal_mode=WAL;',
      'CREATE TABLE settings',
      'CREATE TABLE sessions',
      'CREATE TABLE folders',
      'CREATE TABLE sync_state (',
      'CREATE TABLE messages (',
      'CREATE TABLE conversation_state (',
      'CREATE TABLE vip (',
      'CREATE TABLE rules (',
      'CREATE TABLE action_log (',
      'CREATE TABLE ai_results (',
      'CREATE VIRTUAL TABLE messages_fts USING fts5(',
      'content=messages, content_rowid=rowid',
      'CREATE TRIGGER messages_ai',
      'CREATE TRIGGER messages_ad',
      'CREATE TRIGGER messages_au',
      'CREATE INDEX ix_msg_folder_received',
      'CREATE INDEX ix_msg_conv',
      'CREATE INDEX ix_msg_unread',
      'CREATE INDEX ix_msg_score',
      'CREATE INDEX ix_msg_from',
      'effective_at TEXT',
      'is_from_me INTEGER',
      'base_score INTEGER',
      'score INTEGER',
      'score_breakdown_json TEXT',
      'auto_categories_json TEXT',
      'last_seen_sync TEXT',
    ]);
  });

  it('forbids rowid-renumbering writes in the frozen schema file', () => {
    // The header comment mentions VACUUM as a warning; assert no executable statement.
    expect(migration).not.toMatch(/\n\s*VACUUM\b/i);
    expect(migration).not.toContain('INSERT OR REPLACE');
  });

  it('freezes every Graph shape and the optional-field rule', () => {
    expectAll(graphTypes, [
      'export type GraphEmailAddress',
      'export type GraphRecipient',
      'export type GraphMessage',
      'export type GraphFolder',
      "export type WellKnownFolderName = 'inbox' | 'sentitems' | 'archive' | 'deleteditems';",
      'export type GraphUser',
      'export type GraphBody',
      'export type GraphDeltaResponse',
      'export type GraphListResponse',
      'export type GraphBatchSubResponse',
      'export type GraphBatchResponse',
      'export type GraphErrorBody',
      'conversationId?: string;',
      'toRecipients?: GraphRecipient[];',
      'ccRecipients?: GraphRecipient[];',
      'hasAttachments?: boolean;',
      "flagStatus?: 'notFlagged' | 'flagged' | 'complete';",
      "'@removed'?: { reason?: string };",
      "'@odata.nextLink'?: string;",
      "'@odata.deltaLink'?: string;",
      'Most fields are optional because a delta page may omit them.',
    ]);
  });

  it('never freezes token material into the shared Graph types', () => {
    expect(graphTypes).not.toMatch(/accessToken|refreshToken|client_secret/i);
  });
});
