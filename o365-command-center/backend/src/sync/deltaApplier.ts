import type Database from 'better-sqlite3';
import { upsertMessage } from '../db/db.js';
import type { GraphMessage } from '../graph/types.js';

type ExistingMessage = {
  folder_id: string;
  from_address: string | null;
  received_at: string | null;
  sent_at: string | null;
  is_from_me: number | null;
};

export type DeltaPageLinks = {
  nextLink?: string;
  deltaLink?: string;
  windowDays: number;
  fullResync?: boolean;
};

export const FULL_RESYNC_UNSEEN_MARKER = '1970-01-01T00:00:00.000Z';

type CachedMessage = Record<string, string | number | null>;

const removedMessagesByDatabase = new WeakMap<Database.Database, Map<string, CachedMessage>>();

/** Forget deleted-row snapshots after the entire delta run has completed. */
export function clearPendingRemovedMessages(database: Database.Database): void {
  removedMessagesByDatabase.delete(database);
}

export function applyDeltaPage(
  database: Database.Database,
  folderId: string,
  messages: GraphMessage[],
  links: DeltaPageLinks,
  userAddresses: string[],
): void {
  const pendingRemoved =
    removedMessagesByDatabase.get(database) ?? new Map<string, CachedMessage>();
  const removedThisPage = new Map<string, CachedMessage>();
  const restoredThisPage = new Set<string>();
  const transaction = database.transaction(() => {
    const now = new Date().toISOString();
    for (const message of messages) {
      const existing = database
        .prepare(
          'SELECT folder_id, from_address, received_at, sent_at, is_from_me FROM messages WHERE id = ?',
        )
        .get(message.id) as ExistingMessage | undefined;

      if (message['@removed']) {
        if (existing?.folder_id === folderId) {
          const snapshot = database
            .prepare('SELECT * FROM messages WHERE id = ?')
            .get(message.id) as CachedMessage | undefined;
          if (snapshot) removedThisPage.set(message.id, snapshot);
          database
            .prepare('DELETE FROM messages WHERE id = ? AND folder_id = ?')
            .run(message.id, folderId);
        }
        continue;
      }

      const fromRecipient = message.from ?? message.sender;
      const senderAddress = fromRecipient?.emailAddress?.address;
      const fromAddress = senderAddress === undefined ? existing?.from_address : senderAddress;
      const isFromMe =
        fromAddress === undefined || fromAddress === null
          ? existing?.is_from_me
          : Number(userAddresses.some((address) => address === fromAddress.toLowerCase()));
      const receivedAt = message.receivedDateTime ?? existing?.received_at;
      const sentAt = message.sentDateTime ?? existing?.sent_at;
      const effectiveAt =
        isFromMe === undefined || isFromMe === null
          ? undefined
          : isFromMe === 1
            ? sentAt
            : receivedAt;
      const isOutsideWindow =
        typeof effectiveAt === 'string' &&
        links.windowDays > 0 &&
        !Number.isNaN(Date.parse(effectiveAt)) &&
        Date.parse(effectiveAt) < Date.now() - links.windowDays * 24 * 60 * 60 * 1_000;

      if (isOutsideWindow) {
        if (existing?.folder_id === folderId && !links.fullResync) {
          database
            .prepare('DELETE FROM messages WHERE id = ? AND folder_id = ?')
            .run(message.id, folderId);
        }
        continue;
      }

      const row: Record<string, string | number | null> = {
        id: message.id,
        folder_id: message.parentFolderId ?? existing?.folder_id ?? folderId,
        last_seen_sync: now,
      };
      const prior = existing ?? removedThisPage.get(message.id) ?? pendingRemoved.get(message.id);
      if (prior) {
        for (const [column, value] of Object.entries(prior)) {
          if (column !== 'id' && column !== 'folder_id' && column !== 'last_seen_sync') {
            row[column] = value;
          }
        }
        if (!existing) restoredThisPage.add(message.id);
      }
      if (isFromMe !== undefined && isFromMe !== null) row.is_from_me = isFromMe;
      if (effectiveAt !== undefined) row.effective_at = effectiveAt;
      if (message.conversationId !== undefined) row.conversation_id = message.conversationId;
      if (message.subject !== undefined) row.subject = message.subject;
      if (fromRecipient !== undefined) {
        if (senderAddress !== undefined) row.from_address = senderAddress.toLowerCase();
        if (fromRecipient?.emailAddress?.name !== undefined) {
          row.from_name = fromRecipient.emailAddress.name;
        }
      }
      if (message.toRecipients !== undefined) row.to_json = JSON.stringify(message.toRecipients);
      if (message.ccRecipients !== undefined) row.cc_json = JSON.stringify(message.ccRecipients);
      if (message.receivedDateTime !== undefined) row.received_at = message.receivedDateTime;
      if (message.sentDateTime !== undefined) row.sent_at = message.sentDateTime;
      if (message.isRead !== undefined) row.is_read = Number(message.isRead);
      if (message.importance !== undefined) row.importance = message.importance;
      if (message.hasAttachments !== undefined)
        row.has_attachments = Number(message.hasAttachments);
      if (message.flag?.flagStatus !== undefined) row.flag_status = message.flag.flagStatus;
      if (message.categories !== undefined)
        row.categories_json = JSON.stringify(message.categories);
      if (message.bodyPreview !== undefined) row.body_preview = message.bodyPreview;
      if (message.inferenceClassification !== undefined)
        row.inference_class = message.inferenceClassification;
      if (message.webLink !== undefined) row.web_link = message.webLink;
      if (message.isDraft !== undefined) row.is_draft = Number(message.isDraft);
      upsertMessage(database, row);
    }

    database
      .prepare(
        `INSERT INTO sync_state
          (folder_id, delta_link, resume_link, window_days, last_sync_at, status, error)
         VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(folder_id) DO UPDATE SET
          delta_link = COALESCE(excluded.delta_link, sync_state.delta_link),
          resume_link = excluded.resume_link,
          window_days = excluded.window_days,
          last_sync_at = excluded.last_sync_at,
          status = excluded.status,
          error = NULL`,
      )
      .run(
        folderId,
        links.deltaLink ?? null,
        links.nextLink ?? null,
        links.windowDays,
        now,
        links.nextLink ? (links.fullResync ? 'resyncing' : 'syncing') : 'idle',
      );

    if (links.deltaLink && links.fullResync) {
      database
        .prepare('DELETE FROM messages WHERE folder_id = ? AND last_seen_sync = ?')
        .run(folderId, FULL_RESYNC_UNSEEN_MARKER);
      database
        .prepare('UPDATE sync_state SET last_full_sync_at = ? WHERE folder_id = ?')
        .run(now, folderId);
    }
  });
  transaction();
  for (const [id, snapshot] of removedThisPage) {
    if (!restoredThisPage.has(id)) pendingRemoved.set(id, snapshot);
  }
  for (const id of restoredThisPage) pendingRemoved.delete(id);
  if (pendingRemoved.size > 0) removedMessagesByDatabase.set(database, pendingRemoved);
  else removedMessagesByDatabase.delete(database);
}
