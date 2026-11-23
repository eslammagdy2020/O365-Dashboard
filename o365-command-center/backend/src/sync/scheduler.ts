import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import type Database from 'better-sqlite3';
import type { WellKnownFolderName } from '../graph/types.js';
import type { SyncService } from './syncService.js';

export type SyncSettings = {
  syncWindowDays: number;
  syncIntervalSeconds: number;
  folders: WellKnownFolderName[];
};

const defaults: SyncSettings = {
  syncWindowDays: 90,
  syncIntervalSeconds: 60,
  folders: ['inbox', 'sentitems', 'archive'],
};

export function readSyncSettings(database: Database.Database): SyncSettings {
  const row = database
    .prepare('SELECT value_json FROM settings WHERE key = ?')
    .get('sync') as { value_json: string } | undefined;
  if (!row) return defaults;
  try {
    const value: unknown = JSON.parse(row.value_json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults;
    const candidate = value as Partial<SyncSettings>;
    return {
      syncWindowDays:
        typeof candidate.syncWindowDays === 'number' && candidate.syncWindowDays >= 0
          ? candidate.syncWindowDays
          : defaults.syncWindowDays,
      syncIntervalSeconds:
        typeof candidate.syncIntervalSeconds === 'number' && candidate.syncIntervalSeconds >= 30
          ? candidate.syncIntervalSeconds
          : defaults.syncIntervalSeconds,
      folders: Array.isArray(candidate.folders)
        ? candidate.folders.filter((folder): folder is WellKnownFolderName =>
        ['inbox', 'sentitems', 'archive', 'deleteditems'].includes(folder),
          )
        : defaults.folders,
    };
  } catch {
    return defaults;
  }
}

export function syncFolderNames(settings: SyncSettings): WellKnownFolderName[] {
  return [...new Set(settings.folders)];
}

export class SyncScheduler {
  private accountId: string | null = null;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private nextRunAt: Date | null = null;
  private retentionJob: ScheduledTask | undefined;
  private nightlyJob: ScheduledTask | undefined;

  constructor(
    private readonly database: Database.Database,
    private readonly syncService: SyncService,
  ) {}

  start(homeAccountId: string): void {
    if (this.running) {
      this.accountId = homeAccountId;
      return;
    }
    this.accountId = homeAccountId;
    this.running = true;
    this.nextRunAt = new Date(Date.now() + readSyncSettings(this.database).syncIntervalSeconds * 1_000);
    this.syncService.setNextRunAt(this.nextRunAt);
    this.timer = setInterval(() => this.tick(), 1_000);
    this.retentionJob = cron.schedule('0 * * * *', () => this.runRetention());
    this.nightlyJob = cron.schedule('5 0 * * *', () => this.runNightlyCleanup());
    this.syncService.start(homeAccountId);
  }

  settingsChanged(runImmediately = false): void {
    if (!this.running) return;
    this.nextRunAt = new Date(
      Date.now() + (runImmediately ? 0 : readSyncSettings(this.database).syncIntervalSeconds * 1_000),
    );
    this.syncService.setNextRunAt(this.nextRunAt);
  }

  async shutdown(): Promise<void> {
    this.running = false;
    this.accountId = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.retentionJob?.stop();
    this.nightlyJob?.stop();
    this.retentionJob = undefined;
    this.nightlyJob = undefined;
  }

  runNow(homeAccountId: string): void {
    if (!this.running) this.start(homeAccountId);
    this.nextRunAt = new Date(Date.now() + readSyncSettings(this.database).syncIntervalSeconds * 1_000);
    this.syncService.setNextRunAt(this.nextRunAt);
    this.syncService.start(homeAccountId);
  }

  runRetentionNow(): void {
    this.runRetention();
  }

  private tick(): void {
    if (!this.running || !this.accountId || !this.nextRunAt || Date.now() < this.nextRunAt.getTime()) return;
    const accountId = this.accountId;
    this.nextRunAt = new Date(Date.now() + readSyncSettings(this.database).syncIntervalSeconds * 1_000);
    this.syncService.setNextRunAt(this.nextRunAt);
    this.syncService.start(accountId);
  }

  private runRetention(): void {
    try {
      const now = Date.now();
      this.database.transaction(() => {
        this.database.prepare("UPDATE action_log SET undo_json = NULL WHERE undo_json IS NOT NULL AND ts < ?")
          .run(new Date(now - 24 * 60 * 60 * 1_000).toISOString());
        this.database.prepare('DELETE FROM action_log WHERE ts < ?')
          .run(new Date(now - 30 * 24 * 60 * 60 * 1_000).toISOString());
        this.database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date(now).toISOString());
        this.database.prepare('DELETE FROM ai_results WHERE created_at < ?')
          .run(new Date(now - 90 * 24 * 60 * 60 * 1_000).toISOString());
      })();
    } catch {
      this.persistWarning('Hourly retention cleanup failed');
    }
  }

  private runNightlyCleanup(): void {
    try {
      const cutoff = readSyncSettings(this.database).syncWindowDays > 0
        ? new Date(Date.now() - readSyncSettings(this.database).syncWindowDays * 24 * 60 * 60 * 1_000).toISOString()
        : null;
      if (cutoff) this.database.prepare('DELETE FROM messages WHERE effective_at < ?').run(cutoff);
    } catch {
      this.persistWarning('Nightly sync-window cleanup failed');
    }
  }

  private persistWarning(warning: string): void {
    try {
      const row = this.database.prepare('SELECT value_json FROM settings WHERE key = ?').get('syncWarnings') as
        | { value_json: string }
        | undefined;
      const current: unknown = row ? JSON.parse(row.value_json) : [];
      const warnings = Array.isArray(current)
        ? current.filter((item): item is string => typeof item === 'string' && item !== warning)
        : [];
      warnings.push(warning);
      this.database.prepare(
        `INSERT INTO settings (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      ).run('syncWarnings', JSON.stringify(warnings));
    } catch {
      // Warning persistence itself may fail only when the local database is unavailable.
    }
  }
}
