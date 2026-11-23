import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDataPaths } from '../src/config/paths.js';
import { applyMigrations, openDatabase, upsertMessage } from '../src/db/db.js';

const temporaryDirectories: string[] = [];

function createDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'o365-db-test-'));
  temporaryDirectories.push(directory);
  const database = openDatabase(resolveDataPaths(directory));
  return { database, directory };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('local database bootstrap and FTS', () => {
  it('creates the frozen schema, indexes, FTS table and triggers in WAL mode', () => {
    const { database } = createDatabase();
    try {
      expect(database.pragma('journal_mode', { simple: true })).toBe('wal');

      const objects = database
        .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
        .all() as Array<{ type: string; name: string }>;
      const tables = new Set(objects.filter((object) => object.type === 'table').map(({ name }) => name));
      const indexes = new Set(objects.filter((object) => object.type === 'index').map(({ name }) => name));
      const triggers = new Set(objects.filter((object) => object.type === 'trigger').map(({ name }) => name));

      for (const table of [
        'settings',
        'sessions',
        'folders',
        'sync_state',
        'messages',
        'messages_fts',
        'conversation_state',
        'vip',
        'rules',
        'action_log',
        'ai_results',
        'schema_migrations',
      ]) {
        expect(tables.has(table), `missing table ${table}`).toBe(true);
      }
      for (const index of [
        'ix_msg_folder_received',
        'ix_msg_conv',
        'ix_msg_unread',
        'ix_msg_score',
        'ix_msg_from',
      ]) {
        expect(indexes.has(index), `missing index ${index}`).toBe(true);
      }
      for (const trigger of ['messages_ai', 'messages_ad', 'messages_au']) {
        expect(triggers.has(trigger), `missing trigger ${trigger}`).toBe(true);
      }
    } finally {
      database.close();
    }
  });

  it('updates FTS when subject and sender change and removes terms on delete', () => {
    const { database } = createDatabase();
    try {
      const search = (term: string) =>
        database.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all(term);

      upsertMessage(database, {
        id: 'message-1',
        folder_id: 'inbox',
        subject: 'oldsubjecttoken',
        from_address: 'oldsendertoken@example.com',
        received_at: new Date('2026-11-22T12:34:56+02:00'),
      });
      expect(search('oldsubjecttoken')).toHaveLength(1);
      expect(search('oldsendertoken')).toHaveLength(1);
      expect(
        database.prepare('SELECT received_at FROM messages WHERE id = ?').get('message-1'),
      ).toEqual({ received_at: '2026-11-22T10:34:56.000Z' });

      upsertMessage(database, {
        id: 'message-1',
        folder_id: 'inbox',
        subject: 'newsubjecttoken',
        from_address: 'newsendertoken@example.com',
      });
      expect(search('oldsubjecttoken')).toHaveLength(0);
      expect(search('oldsendertoken')).toHaveLength(0);
      expect(search('newsubjecttoken')).toHaveLength(1);
      expect(search('newsendertoken')).toHaveLength(1);

      database.prepare('DELETE FROM messages WHERE id = ?').run('message-1');
      expect(search('newsubjecttoken')).toHaveLength(0);
      expect(search('newsendertoken')).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it('applies migrations idempotently and keeps the database usable', () => {
    const { database } = createDatabase();
    try {
      applyMigrations(database);
      applyMigrations(database);

      expect(database.prepare('SELECT version, name FROM schema_migrations').all()).toEqual([
        { version: 1, name: '001_init.sql' },
      ]);
      upsertMessage(database, { id: 'usable', folder_id: 'inbox', subject: 'stillusable' });
      expect(
        database.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all('stillusable'),
      ).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});
