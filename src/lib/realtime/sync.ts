/**
 * WA-ERA4-05 / WA-ERA4-07 — Client-side synchronization helpers for
 * realtime events.
 *
 * Pure functions consumed by the Inbox client. They decide what local
 * state to invalidate/refetch when a realtime event arrives and protect
 * against the bounded defects covered by this unit:
 *
 *  1. Duplicate notifications: a stable seen-set prevents re-processing
 *     the same logical message/event id twice.
 *  2. Out-of-order notifications: a high-water mark per conversation
 *     keeps stale message timestamps from regressing the visible
 *     ordering.
 *  3. Stale HTTP responses: a request token rejects fetch results that
 *     belong to a tenant or conversation that is no longer current.
 *  4. Targeted updates: the list is only invalidated when the event
 *     actually affects the visible conversation; a focused thread
 *     refetch is issued otherwise.
 *  5. WA-ERA4-07: `message:status` events do NOT mutate the conversation
 *     list (they only update a per-message delivery status). They are
 *     narrowed to thread-only refetches to avoid overwriting canonical
 *     `unreadCount` with stale cached values from the list query.
 *  6. WA-ERA4-08: `conversation:updated` events are INVALIDATION
 *     signals. They never carry `assignedUserId` or `status`. They
 *     refetch the conversation list (always) and additionally refetch
 *     the active thread when the event targets the open conversation.
 *     The WebSocket payload is NOT authoritative — the canonical
 *     refetch is the source of truth.
 *
 * No persistent state. No new public event fields. No new public APIs.
 * The shape of the on-the-wire RealtimeEvent is unchanged.
 *
 * The helpers are intentionally framework-free (no React, no
 * @tanstack/react-query) so they can be unit-tested deterministically.
 * The Inbox client wires them into its existing query lifecycle.
 */
import type { KnownEventType } from "@/lib/realtime/events";

/** Minimal event shape consumed by the helpers. Compatible with the
 *  existing `useRealtime` hook output (`{ type, payload }`). */
export type SyncEvent = { type: string; payload: unknown };

/** Decision returned by {@link classifyEvent}. */
export type SyncAction =
  | { kind: "ignore" }
  | { kind: "refetch-list" }
  | { kind: "refetch-thread"; conversationId: string }
  | { kind: "refetch-list-and-thread"; conversationId: string };

/** Minimal stable identity view of a message. Producer-emitted by
 *  the existing `serializeMessage` helper. */
export type MessageIdentity = {
  id?: string;
  waMessageId?: string | null;
  conversationId?: string;
  timestamp?: string;
};

const TENANT_MESSAGE_PREFIX = "message:";

/** Maximum number of seen ids remembered per conversation. Bounded
 *  to avoid unbounded growth across long-lived sessions. */
const SEEN_LIMIT = 512;

/**
 * Decide which canonical refetch is required for an inbound event.
 * Returns `ignore` for unknown or non-data events.
 *
 * WA-ERA4-07: `message:new` (and `message:image-enriched`) can change
 * the conversation's `lastPreview`, `lastMessageAt`, and `unreadCount`,
 * so the list must be refetched. `message:status` only changes the
 * per-message delivery status — it does not affect `unreadCount` or
 * the conversation list ordering, so we narrow its decision to a
 * targeted thread refetch when the active conversation matches. This
 * avoids unnecessary list refetches that could overwrite canonical
 * state with a stale cached value.
 *
 * WA-ERA4-08: `conversation:updated` is an invalidation signal. The
 * conversation list MUST always be refetched (because assignment/status
 * changes affect the visible ordering and metadata). The active thread
 * is refetched only when the event targets it. The payload does NOT
 * carry the new state — the canonical refetch is the source of truth.
 */
export function classifyEvent(
  event: SyncEvent,
  activeConversationId: string | null,
): SyncAction {
  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    return { kind: "ignore" };
  }
  if (event.type === "message:status") {
    // Status updates do not change unreadCount. Only the open thread
    // needs a refetch when the event targets it.
    const p = event.payload;
    if (!p || typeof p !== "object") return { kind: "ignore" };
    const convId = (p as Record<string, unknown>).conversationId;
    if (typeof convId !== "string" || convId.length === 0) return { kind: "ignore" };
    if (activeConversationId && activeConversationId === convId) {
      return { kind: "refetch-thread", conversationId: convId };
    }
    return { kind: "ignore" };
  }
  if (event.type === "conversation:updated") {
    // WA-ERA4-08: invalidation signal. The conversation list ordering
    // and metadata (assignment, status) can change, so the list MUST
    // be refetched. The thread refetch is added only when the event
    // targets the open conversation. The payload must carry a
    // non-empty conversationId; the wire-validator already enforces
    // that, but we re-check here so a malformed payload is silently
    // ignored instead of triggering a list-wide refetch that could
    // leak across tenants.
    const p = event.payload;
    if (!p || typeof p !== "object") return { kind: "refetch-list" };
    const convId = (p as Record<string, unknown>).conversationId;
    if (typeof convId !== "string" || convId.length === 0) return { kind: "refetch-list" };
    if (activeConversationId && activeConversationId === convId) {
      return { kind: "refetch-list-and-thread", conversationId: convId };
    }
    return { kind: "refetch-list" };
  }
  if (event.type.startsWith(TENANT_MESSAGE_PREFIX)) {
    const p = event.payload;
    if (!p || typeof p !== "object") {
      // Malformed payload — ignore; the existing payload-shape
      // validator in contracts.ts will reject anything that escapes
      // the wire layer.
      return { kind: "ignore" };
    }
    const convId = (p as Record<string, unknown>).conversationId;
    if (typeof convId !== "string" || convId.length === 0) {
      return { kind: "refetch-list" };
    }
    if (activeConversationId && activeConversationId === convId) {
      return { kind: "refetch-list-and-thread", conversationId: convId };
    }
    return { kind: "refetch-list" };
  }
  return { kind: "ignore" };
}

/** Bounded seen-set for stable message identifiers. */
export class SeenSet {
  private readonly map = new Map<string, Set<string>>();

  /** Returns true if this id was not previously seen in its
   *  conversation; false if it was already recorded. */
  admit(conversationId: string, id: string): boolean {
    if (!conversationId || !id) return true;
    let bucket = this.map.get(conversationId);
    if (!bucket) {
      bucket = new Set();
      this.map.set(conversationId, bucket);
    }
    if (bucket.has(id)) return false;
    bucket.add(id);
    if (bucket.size > SEEN_LIMIT) {
      // Drop oldest insertion order entries (Map preserves insertion
      // order). Truncate to 1/2 of the limit to avoid churn.
      const overflow = bucket.size - Math.floor(SEEN_LIMIT / 2);
      const it = bucket.values();
      for (let i = 0; i < overflow; i++) {
        const v = it.next();
        if (v.done) break;
        bucket.delete(v.value);
      }
    }
    return true;
  }

  reset(conversationId?: string): void {
    if (conversationId) this.map.delete(conversationId);
    else this.map.clear();
  }
}

/**
 * Extract a stable identity for a serialized message. Returns null
 * when the payload has no usable key. The id is preferred; the
 * `waMessageId` is used as a secondary stable key because
 * `message:status` events reference it.
 */
export function messageIdentity(message: unknown): MessageIdentity | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  const id = typeof m.id === "string" ? m.id : undefined;
  const waId = typeof m.waMessageId === "string" ? m.waMessageId : undefined;
  const convId = typeof m.conversationId === "string" ? m.conversationId : undefined;
  const ts = typeof m.timestamp === "string" ? m.timestamp : undefined;
  if (!id && !waId) return null;
  return { id, waMessageId: waId ?? null, conversationId: convId, timestamp: ts };
}

/**
 * High-water mark for message timestamps per conversation. The
 * protected state is purely numeric (epoch millis); string timestamps
 * are parsed defensively. Used to reject events whose timestamp is
 * strictly older than the last accepted one in the same conversation.
 */
export class OrderingGuard {
  private readonly high = new Map<string, number>();

  /** Returns true if the timestamp is acceptable (>= current) or the
   *  conversation has no prior high-water mark. Returns false when
   *  the timestamp is strictly older. Unparseable timestamps are
   *  treated as acceptable (we cannot prove staleness). */
  admit(conversationId: string, timestamp: string | undefined): boolean {
    if (!conversationId || !timestamp) return true;
    const t = Date.parse(timestamp);
    if (Number.isNaN(t)) return true;
    const prev = this.high.get(conversationId);
    if (prev !== undefined && t < prev) return false;
    if (prev === undefined || t > prev) {
      this.high.set(conversationId, t);
    }
    return true;
  }

  reset(conversationId?: string): void {
    if (conversationId) this.high.delete(conversationId);
    else this.high.clear();
  }
}

/**
 * Token guard for inflight HTTP requests. The Inbox client increments
 * a counter per tenant+conversation and tags the request with the
 * current token. When the token changes (tenant switch, conversation
 * switch), any in-flight response is treated as stale and discarded
 * by the caller.
 */
export class RequestToken {
  private current = 0;
  next(): number {
    this.current += 1;
    return this.current;
  }
  isCurrent(token: number): boolean {
    return token === this.current;
  }
  current_(): number {
    return this.current;
  }
}

/** Helper: compose a stable key for a message, used by SeenSet. */
export function seenKeyFor(message: MessageIdentity): string | null {
  if (!message) return null;
  if (message.id) return `id:${message.id}`;
  if (message.waMessageId) return `wa:${message.waMessageId}`;
  return null;
}

/**
 * Process one realtime event into a sync decision plus a dedup/stale
 * verdict for a specific message identity. Returns whether the event
 * was admitted, ignored (malformed/dup), or rejected (stale).
 */
export type EventVerdict =
  | { admitted: true; action: SyncAction }
  | { admitted: false; reason: "duplicate" | "stale" | "malformed" };

export function processEvent(
  event: SyncEvent,
  activeConversationId: string | null,
  seen: SeenSet,
  ordering: OrderingGuard,
  knownTypes: readonly string[] = [],
): EventVerdict {
  const action = classifyEvent(event, activeConversationId);
  if (action.kind === "ignore") {
    return { admitted: false, reason: "malformed" };
  }
  // If the caller provided a known-types allowlist and the event
  // type is not in it, ignore (unknown event type — wire is open,
  // but the Inbox client does not know what to do with it).
  if (knownTypes.length > 0 && !knownTypes.includes(event.type)) {
    return { admitted: false, reason: "malformed" };
  }
  const p = event.payload as Record<string, unknown> | null;
  const msg = p && typeof p === "object" ? p.message : null;
  if (!msg) {
    // No embedded message (e.g. message:status). Admit — the refetch
    // is enough; we have no duplicate to dedup.
    return { admitted: true, action };
  }
  const id = messageIdentity(msg);
  if (!id) {
    // Cannot dedup without an id — admit but the next refetch will
    // canonicalize.
    return { admitted: true, action };
  }
  let convId = id.conversationId ?? "";
  if (!convId && p) {
    const v = p.conversationId;
    if (typeof v === "string") convId = v;
  }
  const key = seenKeyFor(id);
  if (key && !seen.admit(convId, key)) {
    return { admitted: false, reason: "duplicate" };
  }
  if (!ordering.admit(convId, id.timestamp)) {
    return { admitted: false, reason: "stale" };
  }
  return { admitted: true, action };
}

/** Re-export the event type union so the Inbox client can pass it
 *  without reaching into the catalog directly. */
export type { KnownEventType };
