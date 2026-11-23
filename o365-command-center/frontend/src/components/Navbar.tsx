import { useEffect, useState } from 'react';
import { apiService } from '../services/ApiService.js';
import type { SyncStatus } from '../services/ApiService.js';

export default function Navbar() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const result = await apiService.getSyncStatus();
        if (active) setStatus(result.data);
      } catch {
        if (active) setError('Sync status unavailable');
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const runSync = async () => {
    setError(null);
    try {
      const result = await apiService.runSync();
      setStatus(result.data);
    } catch {
      setError('Could not start inbox sync');
    }
  };

  const badge = error ?? status?.lastError ?? status?.phase ?? 'Loading sync status';
  return (
    <header className="navbar">
      <div className="brand">O365 Command Center</div>
      <div className="navbar-actions">
        <span
          className={`sync-chip ${status?.phase === 'error' || error ? 'sync-error' : ''}`}
          role="status"
        >
          {badge}
          {status?.folder ? ` · ${status.folder}` : ''}
          {status?.counts.cached !== undefined ? ` · ${status.counts.cached} cached` : ''}
        </span>
        {status?.lastSuccessAt && status.phase === 'idle' ? (
          <span className="last-sync">
            Last synced {new Date(status.lastSuccessAt).toLocaleTimeString()}
          </span>
        ) : null}
        <button type="button" onClick={() => void runSync()} disabled={status?.phase === 'syncing'}>
          {status?.phase === 'syncing' ? 'Syncing…' : 'Sync now'}
        </button>
        <button
          type="button"
          className="sign-out"
          onClick={() => void apiService.signOut().catch(() => setError('Unable to sign out'))}
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
