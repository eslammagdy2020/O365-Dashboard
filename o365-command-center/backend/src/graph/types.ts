/**
 * T0 FROZEN GRAPH SHAPES (PROPOSAL — pending owner confirmation).
 * Workers: import these; do NOT add fields or create parallel shapes.
 *
 * Most fields are optional because a delta page may omit them. An omitted
 * field must keep its cached local value (frozen invariant A1), never be
 * overwritten with null or a default.
 */

export type GraphEmailAddress = {
  address?: string;
  name?: string;
};

export type GraphRecipient = {
  emailAddress?: GraphEmailAddress;
};

export type GraphMessage = {
  id: string;
  conversationId?: string;
  subject?: string | null;
  from?: GraphRecipient | null;
  sender?: GraphRecipient | null;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  importance?: 'low' | 'normal' | 'high';
  hasAttachments?: boolean;
  flag?: { flagStatus?: 'notFlagged' | 'flagged' | 'complete' };
  categories?: string[];
  bodyPreview?: string | null;
  parentFolderId?: string;
  inferenceClassification?: 'focused' | 'other';
  isDraft?: boolean;
  webLink?: string;
  '@removed'?: { reason?: string };
};

export type GraphFolder = {
  id: string;
  displayName?: string;
  parentFolderId?: string | null;
  childFolderCount?: number;
  totalItemCount?: number;
  unreadItemCount?: number;
};

export type WellKnownFolderName = 'inbox' | 'sentitems' | 'archive' | 'deleteditems';

export type GraphUser = {
  id: string;
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
};

export type GraphBody = {
  contentType?: string;
  content?: string;
};

export type GraphDeltaResponse = {
  value: GraphMessage[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
};

export type GraphListResponse<T> = {
  value: T[];
  '@odata.nextLink'?: string;
};

export type GraphBatchSubResponse = {
  id: string;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
};

export type GraphBatchResponse = {
  responses: GraphBatchSubResponse[];
};

export type GraphErrorBody = {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
};
