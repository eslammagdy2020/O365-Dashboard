import type Database from 'better-sqlite3';
import type { MsalClientProvider } from '../auth/requireAuth.js';
import { acquireGraphToken } from '../auth/tokenCache.js';
import { GraphError } from '../graph/graphClient.js';
import { abortAllGraphRequests } from '../graph/graphClient.js';
import { createMailApi } from '../graph/mailApi.js';
import type { GraphDeltaResponse, WellKnownFolderName } from '../graph/types.js';
import {
  applyDeltaPage,
  clearPendingRemovedMessages,
  FULL_RESYNC_UNSEEN_MARKER,
} from './deltaApplier.js';
import { readSyncSettings, syncFolderNames } from './scheduler.js';

const RESYNC_ERROR_PREFIX = '[full-resync-pending] ';

type SyncStateRow = {
  delta_link: string | null;
  resume_link: string | null;
  window_days: number | null;
  last_sync_at: string | null;
  status: string | null;
  error: string | null;
};

const folderLabels: Record<WellKnownFolderName, string> = {
  inbox: 'Inbox',
  sentitems: 'Sent Items',
  archive: 'Archive',
  deleteditems: 'Deleted Items',
};

export class SyncService {
  private running = false;
  private stopping = false;
  private phase = 'idle';
  private folder: string | null = null;
  private counts: Record<string, number> = {};
  private lastError: string | null = null;
  private nextRunAt: string | null = null;
  private activeRun: Promise<void> | undefined;

  constructor(
    private readonly database: Database.Database,
    private readonly getClient: MsalClientProvider,
  ) {
    const persistedError = this.database
      .prepare('SELECT error FROM sync_state WHERE error IS NOT NULL ORDER BY rowid DESC LIMIT 1')
      .get() as { error: string } | undefined;
    this.lastError = stripResyncMarker(persistedError?.error ?? null);
  }

  status() {
    const persisted = this.database
      .prepare(
        `SELECT last_sync_at, error FROM sync_state
         WHERE status = 'idle' ORDER BY last_sync_at DESC LIMIT 1`,
      )
      .get() as { last_sync_at: string | null; error: string | null } | undefined;
    const errors = this.database
      .prepare('SELECT error FROM sync_state WHERE error IS NOT NULL')
      .all() as Array<{ error: string }>;
    const storedWarnings = this.database
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get('syncWarnings') as { value_json: string } | undefined;
    let warnings: string[] = [];
    try {
      const parsed: unknown = storedWarnings ? JSON.parse(storedWarnings.value_json) : [];
      if (Array.isArray(parsed)) warnings = parsed.filter((item): item is string => typeof item === 'string');
    } catch {
      warnings = ['Sync warnings could not be read'];
    }
    return {
      phase: this.phase,
      folder: this.folder,
      counts: this.counts,
      lastSuccessAt: persisted?.last_sync_at ?? null,
      lastError: this.lastError ?? stripResyncMarker(persisted?.error ?? null),
      nextRunAt: this.nextRunAt,
      warnings: [
        ...new Set([
          ...warnings,
          ...errors.map(({ error }) => stripResyncMarker(error) ?? error),
          ...(this.lastError ? [this.lastError] : []),
        ]),
      ],
    };
  }

  setNextRunAt(nextRunAt: Date | null): void {
    this.nextRunAt = nextRunAt?.toISOString() ?? null;
  }

  start(homeAccountId: string): void {
    if (this.running || this.stopping) return;
    this.running = true;
    this.phase = 'starting';
    this.counts = {};
    this.lastError = null;
    clearPendingRemovedMessages(this.database);
    this.activeRun = this.run(homeAccountId).finally(() => {
      this.running = false;
      this.activeRun = undefined;
    });
  }

  /** Stop accepting runs, abort Graph I/O, and wait for the active transaction boundary. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    abortAllGraphRequests();
    await this.activeRun;
  }

  private async run(homeAccountId: string): Promise<void> {
    let failedFolderId: string | undefined;
    let failedFolderName = 'Inbox';
    let activeFullResync = false;
    try {
      const settings = readSyncSettings(this.database);
      const client = await this.getClient();
      await acquireGraphToken(client, homeAccountId);
      const mailApi = createMailApi(client, homeAccountId);
      const me = await mailApi.getMe();
      const userAddresses = [me.mail, me.userPrincipalName]
        .filter((address): address is string => typeof address === 'string' && address.length > 0)
        .map((address) => address.toLowerCase());

      this.phase = 'checking_folders';
      let archiveExists = false;
      let archiveFolder: Awaited<ReturnType<typeof mailApi.getWellKnownFolder>> | undefined;
      try {
        archiveFolder = await mailApi.getWellKnownFolder('archive');
        this.upsertFolder(archiveFolder.id, archiveFolder.displayName ?? 'Archive', 'archive');
        archiveExists = true;
      } catch (error) {
        if (error instanceof GraphError && error.status === 404) {
          this.setArchiveWarning(false);
        } else {
          this.addPersistentWarning('Archive folder availability could not be checked');
        }
      }
      if (archiveExists) this.setArchiveWarning(true);

      const folders = [] as Array<{ id: string; name: string; wellKnown: WellKnownFolderName }>;
      const selectedFolders = new Set(settings.folders);
      for (const required of ['inbox', 'sentitems', 'archive'] as const) selectedFolders.add(required);
      for (const wellKnown of syncFolderNames({ ...settings, folders: [...selectedFolders] })) {
        if (wellKnown === 'archive' && !archiveExists) continue;
        failedFolderName = folderLabels[wellKnown];
        let graphFolder: Awaited<ReturnType<typeof mailApi.getWellKnownFolder>>;
        try {
          graphFolder = wellKnown === 'archive'
            ? archiveFolder ?? await mailApi.getWellKnownFolder('archive')
            : await mailApi.getWellKnownFolder(wellKnown);
        } catch (error) {
          if (wellKnown === 'inbox') throw error;
          this.addPersistentWarning(`${folderLabels[wellKnown]} folder could not be loaded`);
          continue;
        }
        this.upsertFolder(graphFolder.id, graphFolder.displayName ?? folderLabels[wellKnown], wellKnown);
        folders.push({
          id: graphFolder.id,
          name: graphFolder.displayName ?? folderLabels[wellKnown],
          wellKnown,
        });
      }

      for (const current of folders) {
        failedFolderId = current.id;
        failedFolderName = current.name;
        this.folder = current.name;
        const state = this.database
          .prepare('SELECT * FROM sync_state WHERE folder_id = ?')
          .get(current.id) as SyncStateRow | undefined;
        const hasFullResyncMarker = Boolean(
          this.database
            .prepare('SELECT 1 FROM messages WHERE folder_id = ? AND last_seen_sync = ? LIMIT 1')
            .get(current.id, FULL_RESYNC_UNSEEN_MARKER),
        );
        const fullResync =
          hasFullResyncMarker ||
          state?.status === 'resyncing' ||
          state?.error?.startsWith(RESYNC_ERROR_PREFIX) === true ||
          isWindowIncrease(settings.syncWindowDays, state?.window_days ?? null);
        activeFullResync = fullResync;

        if (fullResync && !hasFullResyncMarker) this.beginFullResync(current.id, settings.syncWindowDays);

        this.phase = fullResync ? 'resyncing' : 'syncing';
        const continueAt = fullResync
          ? hasFullResyncMarker ? state?.resume_link ?? null : null
          : state?.resume_link ?? state?.delta_link ?? null;
        try {
          await this.syncPages(mailApi, current.id, continueAt, userAddresses, fullResync, settings.syncWindowDays);
        } catch (error) {
          if (!isInvalidDeltaToken(error) || fullResync) throw error;
          activeFullResync = true;
          this.beginFullResync(current.id, settings.syncWindowDays);
          this.phase = 'resyncing';
          await this.syncPages(mailApi, current.id, null, userAddresses, true, settings.syncWindowDays);
        }
        this.database
          .prepare("UPDATE sync_state SET status = 'idle', error = NULL WHERE folder_id = ?")
          .run(current.id);
      }
      this.phase = 'idle';
      this.folder = null;
      this.lastError = null;
    } catch (error) {
      const needsLogin = isLoginRequired(error);
      this.phase = 'error';
      this.lastError = errorMessage(error, needsLogin, failedFolderName);
      if (failedFolderId) {
        this.persistFailure(failedFolderId, activeFullResync ? `${RESYNC_ERROR_PREFIX}${this.lastError}` : this.lastError, needsLogin ? 'login_required' : 'error');
      } else {
        const knownFolder = this.database
          .prepare('SELECT id FROM folders WHERE well_known = ? LIMIT 1')
          .get('inbox') as { id: string } | undefined;
        if (knownFolder) this.persistFailure(knownFolder.id, this.lastError, needsLogin ? 'login_required' : 'error');
        else this.addPersistentWarning(this.lastError);
      }
    } finally {
      clearPendingRemovedMessages(this.database);
      if (this.phase === 'error') this.folder = failedFolderName;
    }
  }

  private upsertFolder(id: string, displayName: string, wellKnown: WellKnownFolderName): void {
    this.database
      .prepare(
        `INSERT INTO folders (id, display_name, well_known) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, well_known = excluded.well_known`,
      )
      .run(id, displayName, wellKnown);
  }

  private setArchiveWarning(exists: boolean): void {
    const warningsRow = this.database
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get('syncWarnings') as { value_json: string } | undefined;
    let warnings: string[] = [];
    try {
      const value: unknown = warningsRow ? JSON.parse(warningsRow.value_json) : [];
      if (Array.isArray(value)) warnings = value.filter((item): item is string => typeof item === 'string');
    } catch {
      warnings = [];
    }
    warnings = warnings.filter((warning) =>
      warning !== 'Archive folder is not available; Archive is not being synced' &&
      warning !== 'Archive folder availability could not be checked',
    );
    if (!exists) warnings.push('Archive folder is not available; Archive is not being synced');
    this.database
      .prepare(
        `INSERT INTO settings (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run('syncWarnings', JSON.stringify(warnings));
  }

  private addPersistentWarning(warning: string): void {
    const row = this.database.prepare('SELECT value_json FROM settings WHERE key = ?').get('syncWarnings') as
      | { value_json: string }
      | undefined;
    let warnings: string[] = [];
    try {
      const value: unknown = row ? JSON.parse(row.value_json) : [];
      if (Array.isArray(value)) warnings = value.filter((item): item is string => typeof item === 'string');
    } catch {
      warnings = [];
    }
    if (!warnings.includes(warning)) warnings.push(warning);
    this.database.prepare(
      `INSERT INTO settings (key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    ).run('syncWarnings', JSON.stringify(warnings));
  }

  private beginFullResync(folderId: string, windowDays: number): void {
    this.database.transaction(() => {
      this.database
        .prepare('UPDATE messages SET last_seen_sync = ? WHERE folder_id = ?')
        .run(FULL_RESYNC_UNSEEN_MARKER, folderId);
      this.database
        .prepare(
          `INSERT INTO sync_state (folder_id, delta_link, resume_link, window_days, status, error)
           VALUES (?, NULL, NULL, ?, 'resyncing', NULL)
           ON CONFLICT(folder_id) DO UPDATE SET delta_link = NULL, resume_link = NULL,
             window_days = excluded.window_days, status = 'resyncing', error = NULL`,
        )
        .run(folderId, windowDays);
    })();
  }

  private async syncPages(
    mailApi: ReturnType<typeof createMailApi>,
    folderId: string,
    continueAt: string | null,
    userAddresses: string[],
    fullResync: boolean,
    windowDays: number,
  ): Promise<void> {
    for await (const page of mailApi.messagesDeltaPages(folderId, continueAt)) {
      this.applyPage(folderId, page, userAddresses, fullResync, windowDays);
    }
  }

  private applyPage(
    folderId: string,
    page: GraphDeltaResponse,
    userAddresses: string[],
    fullResync: boolean,
    windowDays: number,
  ): void {
    applyDeltaPage(
      this.database,
      folderId,
      page.value,
      {
        ...(page['@odata.nextLink'] ? { nextLink: page['@odata.nextLink'] } : {}),
        ...(page['@odata.deltaLink'] ? { deltaLink: page['@odata.deltaLink'] } : {}),
        windowDays,
        ...(fullResync ? { fullResync: true } : {}),
      },
      userAddresses,
    );
    const cached = this.database
      .prepare('SELECT COUNT(*) AS count FROM messages WHERE folder_id = ?')
      .get(folderId) as { count: number };
    const totalCached = this.database.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number };
    this.counts = {
      ...this.counts,
      [folderId]: cached.count,
      processed: (this.counts.processed ?? 0) + page.value.length,
      cached: totalCached.count,
    };
  }

  private persistFailure(folderId: string, error: string, status: 'error' | 'login_required'): void {
    const settings = readSyncSettings(this.database);
      this.database
        .prepare(
          `INSERT INTO sync_state (folder_id, window_days, status, error)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(folder_id) DO UPDATE SET status = excluded.status, error = excluded.error`,
      )
      .run(folderId, settings.syncWindowDays, status, error);
  }
}

function isInvalidDeltaToken(error: unknown): boolean {
  return error instanceof GraphError && error.status === 410 && ['syncStateNotFound', 'resyncRequired'].includes(error.code);
}

function isLoginRequired(error: unknown): boolean {
  return (error instanceof GraphError && error.status === 401) ||
    (error instanceof Error && /interaction_required|invalid_grant|login_required/i.test(error.message));
}

function errorMessage(error: unknown, needsLogin: boolean, folder: string): string {
  if (needsLogin) return `Sign in is required to sync the ${folder.toLowerCase()}`;
  if (error instanceof GraphError) return `${folder} sync failed (${error.code})`;
  return `${folder} sync failed; cached messages remain available`;
}

function stripResyncMarker(error: string | null): string | null {
  return error?.startsWith(RESYNC_ERROR_PREFIX) ? error.slice(RESYNC_ERROR_PREFIX.length) : error;
}

function isWindowIncrease(nextWindow: number, previousWindow: number | null): boolean {
  if (previousWindow === null || previousWindow === 0) return false;
  return nextWindow === 0 || nextWindow > previousWindow;
}
