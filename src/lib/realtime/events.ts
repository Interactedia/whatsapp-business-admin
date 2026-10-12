/**
 * WA-ERA4-04 — Canonical event inventory.
 *
 * Internal contract catalog for realtime events. This module is the SINGLE
 * source of truth for:
 *  - Known event type names
 *  - Payload shape (internal typing, not enforced on the wire)
 *  - Expected scope (tenant or global)
 *  - Producer/consumer mapping
 *
 * Wire compatibility is preserved by keeping the public RealtimeEvent shape
 * (`{ type: string; payload: unknown }`) untouched. Producers may emit
 * additional event types not yet listed here; the catalog is a *positive*
 * list used to strengthen validation, never a closed-world enumeration.
 *
 * Adding a new event:
 *  1. Add the type to TENANT_EVENT_TYPES or GLOBAL_EVENT_TYPES below.
 *  2. Add the payload shape to the discriminated union.
 *  3. Update docs/architecture/era4-realtime-architecture-foundation.md.
 *  4. Do not remove or rename existing entries.
 *
 * Removing or renaming an event is a BREAKING change and forbidden by the
 * WA-ERA4-04 invariants.
 */
import type { RealtimeEvent } from "@/lib/realtime/distribution";

/** Tenant-scoped event type names. MUST be delivered to one tenant. */
export const TENANT_EVENT_TYPES = [
  "message:new",
  "message:status",
  "message:image-enriched",
  "flow:submission",
  "conversation:updated",
] as const;

/** Global event type names. MUST be delivered to every connected client. */
export const GLOBAL_EVENT_TYPES = ["template:status"] as const;

export type TenantEventType = (typeof TENANT_EVENT_TYPES)[number];
export type GlobalEventType = (typeof GLOBAL_EVENT_TYPES)[number];
export type KnownEventType = TenantEventType | GlobalEventType;

/**
 * Internal payload shape union. Used by validators and tests.
 * Producers are not required to match exactly; `unknown` is preserved at the
 * wire boundary. This is a soft contract.
 */
export type KnownEventPayload =
  | MessageNewPayload
  | MessageStatusPayload
  | MessageImageEnrichedPayload
  | FlowSubmissionPayload
  | ConversationUpdatedPayload
  | TemplateStatusPayload;

export type MessageNewPayload = {
  conversationId: string;
  /** Optional: present when produced by webhook (inbound). */
  contactId?: string;
  message: unknown;
};

export type MessageStatusPayload = {
  conversationId: string;
  waMessageId: string;
  status: string;
};

export type MessageImageEnrichedPayload = {
  messageId: string;
  conversationId: string;
  enrichment: unknown;
};

export type FlowSubmissionPayload = {
  conversationId: string;
  submissionId: string;
  launchId: string;
};

/**
 * WA-ERA4-08 — Conversation assignment/status invalidation notification.
 *
 * This event is an INVALIDATION signal, not a copy of the canonical
 * conversation state. The payload carries ONLY the conversationId so the
 * client can issue a canonical refetch from the existing HTTP API. The
 * payload intentionally does NOT include `assignedUserId` or `status`:
 * the producer MUST NOT project mutable state into the event because the
 * event is best-effort and not the source of truth.
 *
 * Scope: tenant. Producer: the conversation PATCH endpoint after a
 * successful canonical write. Consumer: Inbox client (and any other
 * conversation-list view) which must refetch from the canonical HTTP API.
 */
export type ConversationUpdatedPayload = {
  conversationId: string;
};

export type TemplateStatusPayload = {
  id: string;
  status: string;
};

/**
 * Producer/consumer map. Documents the actual call sites discovered at
 * WA-ERA4-04 inspection. Used by tests to lock in compatibility.
 */
export const EVENT_PRODUCER_MAP: Readonly<
  Record<KnownEventType, { producerFiles: readonly string[]; scope: "tenant" | "global" }>
> = {
  "message:new": {
    producerFiles: [
      "src/lib/whatsapp/webhook.ts",
      "src/lib/whatsapp/send.ts",
      "src/lib/whatsapp/outbound/handler.ts",
    ],
    scope: "tenant",
  },
  "message:status": {
    producerFiles: [
      "src/lib/whatsapp/webhook.ts",
      "src/lib/whatsapp/status/reconciliation.ts",
    ],
    scope: "tenant",
  },
  "message:image-enriched": {
    producerFiles: ["src/lib/whatsapp/webhook.ts"],
    scope: "tenant",
  },
  "flow:submission": {
    producerFiles: ["src/lib/whatsapp/flow-submission.ts"],
    scope: "tenant",
  },
  "conversation:updated": {
    producerFiles: [
      "src/app/api/tenants/[tenantId]/conversations/[conversationId]/route.ts",
    ],
    scope: "tenant",
  },
  "template:status": {
    producerFiles: ["src/lib/whatsapp/webhook.ts"],
    scope: "global",
  },
};

/** The single WebSocket client consumer at the wire boundary. */
export const EVENT_CONSUMER_FILES = ["src/hooks/use-realtime.ts"] as const;

/**
 * Is this event type one we know about? Returns the scope when known,
 * null when unknown (forward-compatible: unknown events are still
 * allowed through the wire).
 */
export function scopeForEventType(type: string): "tenant" | "global" | null {
  if ((TENANT_EVENT_TYPES as readonly string[]).includes(type)) return "tenant";
  if ((GLOBAL_EVENT_TYPES as readonly string[]).includes(type)) return "global";
  return null;
}

/**
 * Is this event known to the catalog? Used by tests to assert the
 * positive-list invariant — every producer call site must emit a known
 * type. Forward-compatible producers MAY emit unknown types; the
 * validators tolerate that without rejecting.
 */
export function isKnownEventType(type: string): type is KnownEventType {
  return scopeForEventType(type) !== null;
}

/** Canonical list of event types for documentation and assertions. */
export const ALL_KNOWN_EVENT_TYPES: readonly KnownEventType[] = [
  ...TENANT_EVENT_TYPES,
  ...GLOBAL_EVENT_TYPES,
];

/**
 * Type guard for the existing public RealtimeEvent wire shape. Preserves
 * the loose contract — this only rejects outright non-objects and events
 * without a string type. Payload shape is intentionally NOT narrowed.
 */
export function isRealtimeEvent(value: unknown): value is RealtimeEvent {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.type === "string" && v.type.length > 0;
}
