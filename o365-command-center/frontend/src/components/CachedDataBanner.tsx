import type { SyncStatus } from '../services/ApiService.js';

type CachedDataBannerProps = {
  status: SyncStatus | null;
  unavailable?: boolean;
};

export default function CachedDataBanner({ status, unavailable = false }: CachedDataBannerProps) {
  const stale = unavailable || status?.phase === 'error' || Boolean(status?.lastError) || (status?.warnings.length ?? 0) > 0;
  if (!stale) return null;
  return (
    <aside role="alert" className="cached-data-banner">
      <strong>Cached data, not current.</strong>{' '}
      {unavailable
        ? 'The service is unavailable; showing locally cached messages.'
        : 'The latest sync failed. These messages may be out of date.'}
    </aside>
  );
}
