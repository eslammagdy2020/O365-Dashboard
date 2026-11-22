# Milestone 1 — Frozen contracts (PROPOSAL)

**Status:** PROPOSAL — pending owner confirmation. Not frozen until the owner confirms this document, `backend/src/db/migrations/001_init.sql` and `backend/src/graph/types.ts`.
**Version:** draft 1 · 22 November 2026
**Owner:** the human operator (orchestrator.md hard rule 3). Workers read this file; they do not change it.

## 1. Purpose

These contracts fix the decisions that parallel workers would otherwise invent differently: the shape of a message row, the shape of every API response, and the two safety invariants from Appendix A of the build specification. Freeze them once so each implementation ticket can land green without redoing another worker's work.

**Change control:** any edit to this document, the migration or the Graph types requires owner approval. If you find a gap or conflict, append it to `tickets/QUESTIONS.md` and ask the owner — do not patch the contract.

## 2. Scope frozen here

Milestone 1 only: **login → read-only sync → restart/resume → minimal read-only grid.**

No mailbox writes, no category writes, no bulk actions. No scoring, dashboard cards, analytics, settings editors or AI — those belong to later milestones. Score columns exist in the schema but stay `null` in Milestone 1.

The full §8 schema is created now, including tables later milestones will use, so no migration churn is needed later. Workers must never edit the schema or migrations.

## 3. Domain vocabulary (use these words in tickets and code)

- **Synced folders**: Inbox, Sent Items and Archive. Deleted Items is off by default.
- **effective_at**: `sentDateTime` for a message from me, otherwise `receivedDateTime`. It drives the sync window, conversation order and retention. `received_at` stays for display.
- **Sync window**: `syncWindowDays`, default 90, applied locally because Graph caps a filtered delta at 5,000 messages.
- **Delta link / resume link**: the opaque Graph token for the next incremental call; follow verbatim, never rebuild, edit or log.
- **Conversation**: messages sharing a `conversationId`.
- **Managed category**: one of the §10.5 set; no category is written to Outlook in Milestone 1.

## 4. Canonical type declarations

The TypeScript below is the canonical declaration. Copy it verbatim into your module; do not add fields, rename fields or create a parallel shape.

```ts
// Message row used by every list endpoint (spec §12.1).
type MessageRow = {
  id: string;
  conversationId: string;
  folderId: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  receivedAt: string;                      // UTC ISO-8601
  isRead: boolean;
  importance: 'low' | 'normal' | 'high';
  hasAttachments: boolean;
  flagStatus: 'notFlagged' | 'flagged' | 'complete';
  categories: string[];
  autoCategories: string[];
  baseScore: number | null;                // always null in Milestone 1
  score: number | null;                    // always null in Milestone 1
  tier: 'critical' | 'high' | 'medium' | 'low' | null; // always null in Milestone 1
  breakdown?: { factor: string; points: number }[];    // detail endpoint only
  bodyPreview: string;
  webLink: string;
};

type Success<T> = { data: T };
type List<T> = { items: T[]; total: number; offset: number; limit: number };
type ErrorCode =
  | 'login_required' | 'forbidden' | 'not_found' | 'validation_error'
  | 'confirmation_required' | 'draft_not_supported' | 'throttled'
  | 'graph_error' | 'internal_error';
type ApiError = { error: { code: ErrorCode; message: string; requestId?: string } };

// GET /api/sync/status (spec §12.1).
type SyncStatus = {
  phase: string;
  folder: string | null;
  counts: Record<string, number>;
  lastSuccessAt: string | null;
  lastError: string | null;
  nextRunAt: string | null;
  warnings: string[];
};

// Shape reserved for the later write milestone; do not implement in Milestone 1.
type ActionResult = { id: string; ok: boolean; error?: string; noop?: boolean; conflict?: boolean };
type ActionResponse = { data: { batchId: string; results: ActionResult[] } };
```

Response rules: success is `{ data: <object> }`; lists are `{ items, total, offset, limit }` where `total` is the full count for the current filters; errors are the HTTP status plus `{ error: { code, message, requestId? } }` using only the codes above. `limit` is at most 200. Sort keys are whitelisted.

## 5. Frozen safety invariant A1 — conditional sync removal

1. When a delta reports a message as removed from folder **F**, delete the local row **only if** that row's current `folder_id` equals **F**.
2. If the row's folder is different (for example, Archive synced the move first), **ignore** the removal.
3. Omitted delta fields keep their cached values. Never overwrite with `null` or defaults.
4. On HTTP 410 recovery, clear that folder's delta link and run a full unfiltered resync. Delete rows not seen in that resync (`last_seen_sync`) **only after** it completes successfully.

**Required test matrix:** Inbox-removal-first, Archive-added-first, and duplicate replay of each ordering must converge to an identical final state. A test for "omitted subject keeps cached subject" must pass.

## 6. Frozen safety invariant A2 — batches count inner requests

1. The global concurrency limiter is **4** in-flight Graph operations.
2. Each `$batch` inner request counts as **one** operation against that limiter — a batch of 4 inner requests consumes 4 slots. Batches share the limiter with ordinary sync and detail calls.
3. At most 20 sub-requests per `$batch`; at most 2 concurrent batch calls.
4. Parse every sub-response status individually. Retry only items returning 429 or 5xx, at most 3 passes per batch; items still failing are reported failed per item.
5. Honour `Retry-After` on each sub-response, not just on the batch response. Each sub-request carries its own `Prefer: IdType="ImmutableId"` header.

**Required test:** a batch with one throttled sub-response delays only the retry of that sub-request, and measured concurrency never exceeds 4.

## 7. Deferred write contracts (Appendix C)

Acknowledged but not implemented in Milestone 1: conditional-write verification for category PATCHes, server-side exact-message confirmation with expiry, crash-safety intent recording with an `unknown/reconciling` state, and the one-message-then-bulk rollout order. These must be specified before any write code exists.

## 8. Confirmation

- [x] Owner confirms this document is frozen.
- [x] Owner confirms `001_init.sql` is frozen.
- [x] Owner confirms `graph/types.ts` is frozen.
- [x] Only after all three: dispatch T1.
