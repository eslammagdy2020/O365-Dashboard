import type Database from 'better-sqlite3';
import { applyMigrations } from '../../src/db/db.js';

const MESSAGE_COUNT = 50_000;
const PREVIEW_LENGTH = 255;
const SENDER_COUNT = 5_000;
const INBOX_COUNT = MESSAGE_COUNT * 0.6;
const SENT_COUNT = MESSAGE_COUNT * 0.3;
const SENT_FOLDER_ID = 'synthetic-sent';
const OTHER_FOLDER_ID = 'synthetic-other';

/** Create the deterministic 50k cache used by the read-query performance test. */
export function generate50kMessages(database: Database.Database): void {
  applyMigrations(database);
  database
    .prepare('INSERT INTO folders (id, display_name, well_known) VALUES (?, ?, ?)')
    .run('synthetic-inbox', 'Inbox', 'inbox');

  const insert = database.prepare(
    `INSERT INTO messages (
      id, conversation_id, folder_id, subject, from_address, from_name,
      received_at, is_read, importance, has_attachments, flag_status,
      categories_json, body_preview, web_link, is_draft, base_score, score
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)`,
  );
  const previewPadding = ' deterministic synthetic preview'.repeat(9);
  const insertRows = database.transaction(() => {
    for (let index = 0; index < MESSAGE_COUNT; index += 1) {
      const folderId =
        index < INBOX_COUNT
          ? 'synthetic-inbox'
          : index < INBOX_COUNT + SENT_COUNT
            ? SENT_FOLDER_ID
            : OTHER_FOLDER_ID;
      const senderIndex = index % SENDER_COUNT;
      const searchText = index % 10 === 0 ? ' mailsearch' : '';
      const preview = `Preview ${index}${searchText}${previewPadding}`.slice(0, PREVIEW_LENGTH);
      const receivedAt = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
      insert.run(
        `synthetic-${index.toString().padStart(5, '0')}`,
        `conversation-${index}`,
        folderId,
        `Synthetic message ${index}${searchText}`,
        `sender${senderIndex}@example.invalid`,
        `Synthetic Sender ${senderIndex}`,
        receivedAt,
        index % 2,
        'normal',
        index % 7 === 0 ? 1 : 0,
        'notFlagged',
        '[]',
        preview,
        'https://outlook.example.invalid/synthetic',
      );
    }
  });
  insertRows();
}
