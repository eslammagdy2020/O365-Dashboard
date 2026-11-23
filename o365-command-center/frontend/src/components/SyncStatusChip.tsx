import type { SyncStatus } from '../services/ApiService.js';

type SyncStatusChipProps = {
  status: SyncStatus | null;
  unavailable: boolean;
};

export default function SyncStatusChip({ status, unavailable }: SyncStatusChipProps) {
  return (
    <div className={`sync-chip ${status?.phase === 'error' || unavailable ? 'sync-error' : ''}`} role="status">
      {status?.phase ?? (unavailable ? 'Sync status unavailable' : 'Loading sync status')}
      {status?.folder ? ` · ${status.folder}` : ''}
      {status?.counts.cached !== undefined ? ` · ${status.counts.cached} cached` : ''}
      {status?.lastError ? ` · ${status.lastError}` : ''}
      {status?.nextRunAt ? ` · Next run ${new Date(status.nextRunAt).toLocaleTimeString()}` : ''}
    </div>
  );
}
