import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { DataPaths } from '../config/paths.js';
import { ensureDataDirectory, resolveDataPaths } from '../config/paths.js';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const migrationDirectoryCandidates = [
  resolve(moduleDirectory, 'migrations'),
  resolve(moduleDirectory, '../../src/db/migrations'),
  resolve(process.cwd(), 'backend/src/db/migrations'),
  resolve(process.cwd(), 'src/db/migrations'),
];

const messageColumns = new Set([
  'id',
  'conversation_id',
  'folder_id',
  'subject',
  'from_address',
  'from_name',
  'to_json',
  'cc_json',
  'received_at',
  'sent_at',
  'effective_at',
  'is_read',
  'importance',
  'has_attachments',
  'flag_status',
  'categories_json',
  'body_preview',
  'inference_class',
  'web_link',
  'is_draft',
  'is_from_me',
  'base_score',
  'score',
  'score_breakdown_json',
  'auto_categories_json',
  'scored_at',
  'last_seen_sync',
]);

const messageDateColumns = new Set([
  'received_at',
  'sent_at',
  'effective_at',
  'scored_at',
  'last_seen_sync',
]);

export function openDatabase(paths: DataPaths = resolveDataPaths()): Database.Database {
  ensureDataDirectory(paths);

  const database = new Database(paths.database);
  try {
    database.pragma('journal_mode = WAL');
    applyMigrations(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/** Apply each numbered migration once, recording successful applications. */
export function applyMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const migrationDirectory = findMigrationDirectory();
  const migrations = readdirSync(migrationDirectory)
    .filter((name) => /^\d+_[\w.-]+\.sql$/.test(name))
    .map((name) => ({ name, version: Number(name.match(/^\d+/)?.[0]) }))
    .sort((left, right) => left.version - right.version);

  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index]?.version === migrations[index - 1]?.version) {
      throw new Error(`Duplicate migration version ${migrations[index]?.version}`);
    }
  }

  const hasMigration = database.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  const recordMigration = database.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const migration of migrations) {
    if (hasMigration.get(migration.version)) continue;

    database.exec(readFileSync(resolve(migrationDirectory, migration.name), 'utf8'));
    if (tableExists(database, 'messages_fts')) {
      database.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    }
    recordMigration.run(migration.version, migration.name, new Date().toISOString());
  }
}

/**
 * Insert or update a cached message without REPLACE semantics, preserving rowid
 * and allowing the frozen FTS update trigger to remove stale terms.
 */
export function upsertMessage(
  database: Database.Database,
  message: Record<string, string | number | null | Date>,
): void {
  const columns = Object.keys(message);
  if (!columns.includes('id')) throw new Error('A message upsert requires id');
  for (const column of columns) {
    if (!messageColumns.has(column)) throw new Error(`Unknown message column: ${column}`);
  }

  const values = columns.map((column) => {
    const value = message[column];
    if (value instanceof Date) {
      if (!messageDateColumns.has(column)) {
        throw new Error(`Date values are not allowed for ${column}`);
      }
      return value.toISOString();
    }
    if (typeof value === 'string' && messageDateColumns.has(column)) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) throw new Error(`Invalid UTC date for ${column}`);
      return date.toISOString();
    }
    return value;
  });

  const placeholders = columns.map(() => '?').join(', ');
  const updates = columns
    .filter((column) => column !== 'id')
    .map((column) => `${column} = excluded.${column}`);
  const conflictClause = updates.length > 0 ? `DO UPDATE SET ${updates.join(', ')}` : 'DO NOTHING';
  database
    .prepare(
      `INSERT INTO messages (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT(id) ${conflictClause}`,
    )
    .run(...values);
}

function findMigrationDirectory(): string {
  const migrationDirectory = migrationDirectoryCandidates.find(existsSync);

  if (!migrationDirectory) {
    throw new Error(`Could not locate database migrations from ${moduleDirectory}`);
  }
  return migrationDirectory;
}

function tableExists(database: Database.Database, name: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );
}
