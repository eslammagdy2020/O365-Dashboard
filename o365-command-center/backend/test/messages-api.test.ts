import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations, upsertMessage } from '../src/db/db.js';
import {
  buildFtsQuery,
  createMessageDetailController,
  createMessageListController,
} from '../src/controllers/messageController.js';
import { createMessageRoutes } from '../src/routes/messageRoutes.js';

const databases: Database.Database[] = [];
function createDatabase() {
  const database = new Database(':memory:');
  databases.push(database);
  applyMigrations(database);
  database.prepare("INSERT INTO folders (id, display_name, well_known) VALUES ('inbox-1', 'Inbox', 'inbox')").run();
  return database;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('message browse API', () => {
  it('escapes FTS operators as plain text and preserves quoted phrases', () => {
    expect(buildFtsQuery('hello OR * world')).toBe('"hello" AND "world"*');
    expect(buildFtsQuery('"quarterly results" update')).toBe('"quarterly results" AND "update"*');
    expect(buildFtsQuery('!!!')).toBe('');
  });

  it('indexes matching rows and filters, sorts and counts the full result set', () => {
    const database = createDatabase();
    upsertMessage(database, {
      id: 'm-1', folder_id: 'inbox-1', subject: 'oldsubjecttoken Quarterly results', from_name: 'Sender',
      received_at: '2026-11-22T10:00:00.000Z', is_read: 0, has_attachments: 1,
    });
    upsertMessage(database, {
      id: 'm-2', folder_id: 'inbox-1', subject: 'Another update', from_name: 'Other',
      received_at: '2026-11-21T10:00:00.000Z', is_read: 1, has_attachments: 0,
    });
    const search = (term: string) => database.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all(term);
    expect(search('oldsubjecttoken')).toHaveLength(1);
    upsertMessage(database, { id: 'm-1', folder_id: 'inbox-1', subject: 'newsubjecttoken Quarterly results', from_name: 'Changed' });
    expect(search('oldsubjecttoken')).toHaveLength(0);
    expect(search('newsubjecttoken')).toHaveLength(1);

    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const request = { query: { view: 'unread', q: 'Quarterly results', offset: '0', limit: '1', sort: 'subject', order: 'asc' } };
    createMessageListController(database)(request as never, response as never);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      total: 1,
      items: [expect.objectContaining({ id: 'm-1', subject: 'newsubjecttoken Quarterly results' })],
    }));
  });

  it('rejects unapproved sort keys rather than interpolating them', () => {
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    createMessageListController(createDatabase())(
      { query: { sort: 'subject; DROP TABLE messages' } } as never,
      response as never,
    );
    expect(response.status).toHaveBeenCalledWith(400);
  });

  it('rejects requests for folders other than Inbox', () => {
    const database = createDatabase();
    database.prepare("INSERT INTO folders (id, display_name, well_known) VALUES ('archive-1', 'Archive', NULL)").run();
    upsertMessage(database, { id: 'm-archive', folder_id: 'archive-1', subject: 'Archived message' });
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    createMessageListController(database)(
      { query: { folder: 'archive' } } as never,
      response as never,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: { code: 'validation_error', message: 'Only the Inbox folder is supported in Milestone 1' },
    });
  });

  it('accepts the Inbox folder alias and returns the normal Inbox result', () => {
    const database = createDatabase();
    upsertMessage(database, { id: 'm-inbox', folder_id: 'inbox-1', subject: 'Inbox message' });
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    createMessageListController(database)(
      { query: { folder: 'inbox' } } as never,
      response as never,
    );

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith({
      items: [expect.objectContaining({ id: 'm-inbox', folderId: 'inbox-1' })],
      total: 1,
      offset: 0,
      limit: 100,
    });
  });

  it('fetches the body live and returns the frozen detail row plus breakdown and bodyHtml', async () => {
    const database = createDatabase();
    upsertMessage(database, { id: 'm-1', folder_id: 'inbox-1', subject: 'Hello', received_at: '2026-11-22T10:00:00.000Z' });
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const getMailApi = vi.fn(async () => ({ getMessageBody: vi.fn().mockResolvedValue({ contentType: 'html', content: '<p>live body</p>' }) }));
    await createMessageDetailController(database, getMailApi as never)(
      { params: { id: 'm-1' } } as never,
      response as never,
    );
    expect(response.json).toHaveBeenCalledWith({ data: expect.objectContaining({
      id: 'm-1', subject: 'Hello', breakdown: null, bodyHtml: '<p>live body</p>',
    }) });
  });

  it('exposes a detail route for the composition root to inject live Graph access', () => {
    const router = createMessageRoutes(createDatabase(), async () => ({ getMessageBody: async () => ({}) } as never));
    expect(router).toBeTruthy();
  });
});
