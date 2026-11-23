import { useEffect, useState } from 'react';
import EmailGrid from '../components/EmailGrid.js';
import Navbar from '../components/Navbar.js';
import CachedDataBanner from '../components/CachedDataBanner.js';
import SyncStatusChip from '../components/SyncStatusChip.js';
import MessageDetailDrawer from '../components/MessageDetailDrawer.js';
import type { MessageRow, SyncStatus } from '../services/ApiService.js';
import { apiService } from '../services/ApiService.js';

export default function Mail() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [view, setView] = useState('inbox');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const [selectedMessage, setSelectedMessage] = useState<MessageRow | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let active = true;
    let previousPhase = '';
    const refresh = async () => {
      try {
        const { data } = await apiService.getSyncStatus();
        if (active) {
          setStatus(data);
          setStatusUnavailable(false);
        }
        if (active && previousPhase !== 'idle' && data.phase === 'idle') {
          setRefreshKey((value) => value + 1);
        }
        previousPhase = data.phase;
      } catch {
        if (active) setStatusUnavailable(true);
      }
    };
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <main className="mail-page">
      <Navbar />
      <section className="mail-content">
        <div className="mail-heading">
          <div>
            <p className="eyebrow">MAILBOX</p>
            <h1>Inbox</h1>
          </div>
          <p className="read-only-note">Read-only local cache</p>
        </div>
        <CachedDataBanner status={status} unavailable={statusUnavailable} />
        {(status?.warnings.length ?? 0) > 0 ? (
          <aside role="alert" className="cached-data-banner">
            <strong>Sync warning.</strong> {status?.warnings.join(' · ')}
          </aside>
        ) : null}
        {status?.nextRunAt ? (
          <p className="last-synced-time" aria-live="polite">
            Next automatic sync: {new Date(status.nextRunAt).toLocaleTimeString()}
          </p>
        ) : null}
        <p className="last-synced-time" aria-live="polite">
          Last synced: {status?.lastSuccessAt ? new Date(status.lastSuccessAt).toLocaleString() : 'Never'}
        </p>
        <SyncStatusChip status={status} unavailable={statusUnavailable} />
        <div className="mail-toolbar" aria-label="Message filters">
          <label>
            View{' '}
            <select value={view} onChange={(event) => setView(event.target.value)}>
              <option value="inbox">Inbox</option>
              <option value="unread">Unread</option>
              <option value="flagged">Flagged</option>
              <option value="attachments">Attachments</option>
              <option value="today">Today</option>
              <option value="unread48">Unread over 48 hours</option>
            </select>
          </label>
          <label>
            Search messages{' '}
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={'Words or "phrase"'} />
          </label>
        </div>
        <EmailGrid key={`${refreshKey}:${view}:${query}`} view={view} query={query} onOpen={setSelectedMessage} />
      </section>
      <MessageDetailDrawer message={selectedMessage} onClose={() => setSelectedMessage(null)} />
    </main>
  );
}
