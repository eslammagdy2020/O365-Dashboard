import type { Request, Response } from 'express';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { MailApi } from '../graph/mailApi.js';

const querySchema = z.object({
  view: z.enum(['inbox', 'unread', 'flagged', 'attachments', 'today', 'unread48']).default('inbox'),
  folder: z.string().optional(),
  q: z.string().max(500).optional().default(''),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  sort: z.enum(['receivedAt', 'subject', 'fromName', 'importance', 'isRead']).default('receivedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const SORT_COLUMNS = {
  receivedAt: 'm.received_at',
  subject: 'm.subject',
  fromName: 'm.from_name',
  importance: 'm.importance',
  isRead: 'm.is_read',
} as const;

type StoredMessage = {
  id: string;
  conversation_id: string | null;
  folder_id: string;
  subject: string | null;
  from_name: string | null;
  from_address: string | null;
  received_at: string | null;
  is_read: number | null;
  importance: 'low' | 'normal' | 'high' | null;
  has_attachments: number | null;
  flag_status: 'notFlagged' | 'flagged' | 'complete' | null;
  categories_json: string | null;
  auto_categories_json: string | null;
  base_score: number | null;
  score: number | null;
  score_breakdown_json: string | null;
  body_preview: string | null;
  web_link: string | null;
};

type MessageRow = {
  id: string;
  conversationId: string;
  folderId: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  receivedAt: string;
  isRead: boolean;
  importance: 'low' | 'normal' | 'high';
  hasAttachments: boolean;
  flagStatus: 'notFlagged' | 'flagged' | 'complete';
  categories: string[];
  autoCategories: string[];
  baseScore: number | null;
  score: number | null;
  tier: null;
  bodyPreview: string;
  webLink: string;
};

export function buildFtsQuery(input: string): string {
  const chunks = input.match(/"[^"]*"|\S+/gu) ?? [];
  const terms: Array<{ value: string; phrase: boolean }> = [];
  for (const chunk of chunks) {
    const phrase = chunk.startsWith('"') && chunk.endsWith('"');
    const content = phrase ? chunk.slice(1, -1) : chunk;
    if (!phrase && /^(?:AND|OR|NOT|NEAR)$/iu.test(content)) continue;
    const words = content.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (phrase) {
      if (words.length) terms.push({ value: words.join(' '), phrase: true });
    } else {
      terms.push(...words.map((word) => ({ value: word, phrase: false })));
    }
  }
  return terms
    .map(({ value, phrase }, index) => {
      const prefix = !phrase && index === terms.length - 1 ? '*' : '';
      return `"${value}"${prefix}`;
    })
    .join(' AND ');
}

export function createMessageListController(database: Database.Database) {
  return (request: Request, response: Response): void => {
    const query = querySchema.safeParse(request.query);
    if (!query.success) {
      response.status(400).json({
        error: { code: 'validation_error', message: 'Invalid message list parameters' },
      });
      return;
    }
    const inbox = database
      .prepare("SELECT id FROM folders WHERE well_known = 'inbox' LIMIT 1")
      .get() as { id: string } | undefined;
    if (query.data.folder !== undefined && query.data.folder !== 'inbox' && query.data.folder !== inbox?.id) {
      response.status(400).json({
        error: { code: 'validation_error', message: 'Only the Inbox folder is supported in Milestone 1' },
      });
      return;
    }
    if (!inbox) {
      response.json({ items: [], total: 0, offset: query.data.offset, limit: query.data.limit });
      return;
    }

    const { offset, limit, sort, order, view, q } = query.data;
    const filters = ['m.folder_id = ?', 'COALESCE(m.is_draft, 0) = 0'];
    const values: Array<string | number> = [inbox.id];
    if (view === 'unread' || view === 'unread48') filters.push('COALESCE(m.is_read, 0) = 0');
    if (view === 'flagged') filters.push("m.flag_status = 'flagged'");
    if (view === 'attachments') filters.push('COALESCE(m.has_attachments, 0) = 1');
    if (view === 'unread48') {
      filters.push("datetime(m.received_at) <= datetime('now', '-48 hours')");
    }
    if (view === 'today') filters.push("datetime(m.received_at) >= datetime('now', 'start of day')");

    const ftsQuery = buildFtsQuery(q);
    if (ftsQuery) {
      filters.push('m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)');
      values.push(ftsQuery);
    }
    const where = filters.join(' AND ');
    const total = database
      .prepare(`SELECT COUNT(*) AS total FROM messages m WHERE ${where}`)
      .get(...values) as { total: number };
    const rows = database
      .prepare(
        `SELECT m.id, m.conversation_id, m.folder_id, m.subject, m.from_name, m.from_address,
          m.received_at, m.is_read, m.importance, m.has_attachments, m.flag_status,
          m.categories_json, m.auto_categories_json, m.base_score, m.score,
          m.score_breakdown_json, m.body_preview, m.web_link
         FROM messages m WHERE ${where}
         ORDER BY ${SORT_COLUMNS[sort]} ${order.toUpperCase()}, m.id ASC LIMIT ? OFFSET ?`,
      )
      .all(...values, limit, offset) as StoredMessage[];

    response.json({
      items: rows.map(toMessageRow),
      total: total.total,
      offset,
      limit,
    });
  };
}

export function createMessageDetailController(
  database: Database.Database,
  getMailApi?: (request: Request) => Promise<MailApi>,
) {
  return async (request: Request, response: Response): Promise<void> => {
    const id = z.string().min(1).max(512).safeParse(request.params.id);
    if (!id.success) {
      response.status(400).json({ error: { code: 'validation_error', message: 'Invalid message id' } });
      return;
    }
    const row = database
      .prepare(
        `SELECT id, conversation_id, folder_id, subject, from_name, from_address, received_at,
          is_read, importance, has_attachments, flag_status, categories_json, auto_categories_json,
          base_score, score, score_breakdown_json, body_preview, web_link
         FROM messages WHERE id = ? AND COALESCE(is_draft, 0) = 0`,
      )
      .get(id.data) as StoredMessage | undefined;
    if (!row) {
      response.status(404).json({ error: { code: 'not_found', message: 'Message not found' } });
      return;
    }
    if (!getMailApi) {
      response.status(503).json({ error: { code: 'internal_error', message: 'Live message details are unavailable' } });
      return;
    }
    try {
      const body = await (await getMailApi(request)).getMessageBody(id.data);
      response.json({ data: { ...toMessageRow(row), breakdown: null, bodyHtml: body.content ?? '' } });
    } catch {
      response.status(502).json({ error: { code: 'graph_error', message: 'Unable to load the live message body' } });
    }
  };
}

function toMessageRow(row: StoredMessage): MessageRow {
  return {
    id: row.id,
    conversationId: row.conversation_id ?? '',
    folderId: row.folder_id,
    subject: row.subject ?? '',
    fromName: row.from_name ?? '',
    fromAddress: row.from_address ?? '',
    receivedAt: row.received_at ?? '',
    isRead: row.is_read === 1,
    importance: row.importance ?? 'normal',
    hasAttachments: row.has_attachments === 1,
    flagStatus: row.flag_status ?? 'notFlagged',
    categories: parseStringArray(row.categories_json),
    autoCategories: parseStringArray(row.auto_categories_json),
    baseScore: row.base_score,
    score: row.score,
    tier: null,
    bodyPreview: row.body_preview ?? '',
    webLink: row.web_link ?? '',
  };
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}
