export type MessageRow = {
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
  tier: 'critical' | 'high' | 'medium' | 'low' | null;
  bodyPreview: string;
  webLink: string;
};

export type MessageDetail = MessageRow & {
  breakdown: null;
  bodyHtml: string;
};

export type MessageList = {
  items: MessageRow[];
  total: number;
  offset: number;
  limit: number;
};

export type SyncStatus = {
  phase: string;
  folder: string | null;
  counts: Record<string, number>;
  lastSuccessAt: string | null;
  lastError: string | null;
  nextRunAt: string | null;
  warnings: string[];
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    if (response.status === 401) window.location.assign('/auth/login');
    throw new Error('Unable to reach the local mailbox cache');
  }
  return (await response.json()) as T;
}

export const apiService = {
  listMessages(params: {
    offset: number;
    limit: number;
    sort?: string;
    order?: string;
    view?: string;
    q?: string;
  }): Promise<MessageList> {
    const query = new URLSearchParams({
      view: params.view ?? 'inbox',
      offset: String(params.offset),
      limit: String(params.limit),
      sort: params.sort ?? 'receivedAt',
      order: params.order ?? 'desc',
      q: params.q ?? '',
    });
    return request<MessageList>(`/api/messages?${query.toString()}`);
  },

  getMessage(id: string): Promise<{ data: MessageDetail }> {
    return request<{ data: MessageDetail }>(`/api/messages/${encodeURIComponent(id)}`);
  },

  getSyncStatus(): Promise<{ data: SyncStatus }> {
    return request<{ data: SyncStatus }>('/api/sync/status');
  },

  runSync(): Promise<{ data: SyncStatus }> {
    return request<{ data: SyncStatus }>('/api/sync/run', {
      method: 'POST',
      headers: { 'X-Requested-With': 'occ' },
    });
  },

  async signOut(): Promise<void> {
    const response = await fetch('/auth/logout', {
      method: 'POST',
      headers: { 'X-Requested-With': 'occ' },
    });
    if (!response.ok) throw new Error('Unable to sign out');
    window.location.assign('/auth/login');
  },
};
