import type { Request, Response } from 'express';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { WellKnownFolderName } from '../graph/types.js';
import { readSyncSettings } from '../sync/scheduler.js';
import type { SyncScheduler } from '../sync/scheduler.js';

const settingsSchema = z.object({
  syncWindowDays: z.union([z.literal(0), z.literal(30), z.literal(90), z.literal(365)]).optional(),
  syncIntervalSeconds: z.number().int().min(30).max(3600).optional(),
  folders: z.array(z.enum(['inbox', 'sentitems', 'archive', 'deleteditems'])).min(1).optional(),
}).strict();

export function createGetSettingsController(database: Database.Database) {
  return (_request: Request, response: Response): void => {
    response.json({ data: readSyncSettings(database) });
  };
}

export function createPutSettingsController(database: Database.Database, scheduler?: SyncScheduler) {
  return (request: Request, response: Response): void => {
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: { code: 'validation_error', message: 'Settings values are invalid' },
      });
      return;
    }

    const existing = readSyncSettings(database);
    const updated = {
      syncWindowDays: parsed.data.syncWindowDays ?? existing.syncWindowDays,
      syncIntervalSeconds: parsed.data.syncIntervalSeconds ?? existing.syncIntervalSeconds,
      folders: (parsed.data.folders ?? existing.folders) as WellKnownFolderName[],
    };
    database.prepare(
      `INSERT INTO settings (key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    ).run('sync', JSON.stringify(updated));

    const raisedWindow = updated.syncWindowDays === 0 && existing.syncWindowDays !== 0 ||
      updated.syncWindowDays > existing.syncWindowDays && existing.syncWindowDays !== 0;
    const loweredWindow = existing.syncWindowDays === 0 && updated.syncWindowDays !== 0 ||
      updated.syncWindowDays < existing.syncWindowDays && updated.syncWindowDays !== 0;
    if (loweredWindow) {
      database.prepare('DELETE FROM messages WHERE effective_at < ?').run(
        new Date(Date.now() - updated.syncWindowDays * 24 * 60 * 60 * 1_000).toISOString(),
      );
      database.prepare('UPDATE sync_state SET window_days = ?').run(updated.syncWindowDays);
    }
    if (raisedWindow) {
      database.prepare(
        `UPDATE sync_state SET delta_link = NULL, resume_link = NULL, window_days = ?,
         status = 'resyncing', error = NULL`,
      ).run(updated.syncWindowDays);
    }
    scheduler?.settingsChanged(raisedWindow);
    response.json({ data: updated });
  };
}
