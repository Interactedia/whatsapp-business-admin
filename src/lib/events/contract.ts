/**
 * ERA 3 — Canonical External Event Contract.
 *
 * Defines the public, versioned envelope and event families that downstream
 * consumers (CRM, automation, agents) will eventually receive. PostgreSQL
 * remains the system of record; this contract is a transport-shape declaration
 * and does not introduce delivery infrastructure.
 *
 * Design notes:
 * - Provider identifiers (e.g. Meta `wamid`, `metaWabaId`) are exposed only as
 *   supporting references. The envelope is never defined by them alone.
 * - No secrets, credentials, raw webhook payloads, or PII are part of the
 *   contract. Sensitive keys are rejected at validation time.
 * - Every event declares exactly one tenant. Cross-tenant events are invalid.
 * - The contract is intentionally narrow: only event families whose state is
 *   already authoritative in the platform are declared.
 *
 * The allowed value sets mirror the underlying Prisma enums but are kept as
 * local string literals so the contract does not silently change if the
 * internal schema grows.
 */

export const EXTERNAL_EVENT_CONTRACT_VERSION = 1 as const;

export const EXTERNAL_EVENT_TYPES = {
  INBOUND_MESSAGE_RECEIVED: "inbound.message.received",
  OUTBOUND_MESSAGE_ACCEPTED: "outbound.message.accepted",
  OUTBOUND_MESSAGE_STATUS_CHANGED: "outbound.message.status_changed",
  CONVERSATION_CHANGED: "conversation.changed",
} as const;

export type ExternalEventType =
  (typeof EXTERNAL_EVENT_TYPES)[keyof typeof EXTERNAL_EVENT_TYPES];

/**
 * Subset of `MessageStatus` exposed externally. Mirrors the values that
 * downstream consumers can rely on. Values not in this set must not be
 * surfaced as canonical event status.
 */
export const EXTERNAL_MESSAGE_STATUSES = [
  "PENDING",
  "SENT",
  "DELIVERED",
  "READ",
  "FAILED",
  "RECEIVED",
] as const;

export type ExternalMessageStatus = (typeof EXTERNAL_MESSAGE_STATUSES)[number];

/**
 * Subset of `MessageType` exposed externally. New internal-only types are
 * not part of the contract.
 */
export const EXTERNAL_MESSAGE_TYPES = [
  "TEXT",
  "IMAGE",
  "VIDEO",
  "AUDIO",
  "DOCUMENT",
  "STICKER",
  "LOCATION",
  "CONTACTS",
  "TEMPLATE",
  "INTERACTIVE",
  "BUTTON",
  "REACTION",
] as const;

export type ExternalMessageType = (typeof EXTERNAL_MESSAGE_TYPES)[number];

/**
 * Subset of conversation statuses that materially change a conversation's
 * observable state. Assignment state is intentionally absent because user
 * assignment is an internal backoffice concern.
 */
export const EXTERNAL_CONVERSATION_STATUSES = ["OPEN", "CLOSED"] as const;

export type ExternalConversationStatus =
  (typeof EXTERNAL_CONVERSATION_STATUSES)[number];

export const EXTERNAL_CONVERSATION_CHANGE_KINDS = [
  "CREATED",
  "STATUS_CHANGED",
  "REASSIGNED",
] as const;

export type ExternalConversationChangeKind =
  (typeof EXTERNAL_CONVERSATION_CHANGE_KINDS)[number];

export type ExternalEntityKind =
  | "tenant"
  | "waba"
  | "phone"
  | "conversation"
  | "message"
  | "contact"
  | "webhook_event"
  | "outbox_event";

export interface ExternalEntityRef {
  kind: ExternalEntityKind;
  id: string;
  /**
   * Optional provider-specific alias. Never used as the primary identifier
   * of the envelope; consumers must rely on the canonical `id`.
   */
  providerId?: string;
}

export interface ExternalInboundMessageReceivedPayload {
  conversationId: string;
  messageId: string;
  contactId: string;
  phoneNumberId: string;
  wabaAccountId: string;
  type: ExternalMessageType;
  receivedAt: string;
  /** Optional provider message id (e.g. `wamid.*`). Reference only. */
  providerMessageId?: string;
  /** Optional truncated preview of the inbound body. Never the full body. */
  preview?: string;
}

export interface ExternalOutboundMessageAcceptedPayload {
  conversationId: string;
  messageId: string;
  contactId: string;
  phoneNumberId: string;
  wabaAccountId: string;
  type: ExternalMessageType;
  acceptedAt: string;
  /** Optional provider message id assigned after Meta ack. Reference only. */
  providerMessageId?: string;
}

export interface ExternalOutboundMessageStatusChangedPayload {
  conversationId: string;
  messageId: string;
  phoneNumberId: string;
  wabaAccountId: string;
  previousStatus: ExternalMessageStatus | null;
  status: ExternalMessageStatus;
  changedAt: string;
  /** Optional provider message id (e.g. `wamid.*`). Reference only. */
  providerMessageId?: string;
}

export interface ExternalConversationChangedPayload {
  conversationId: string;
  contactId: string;
  phoneNumberId: string | null;
  wabaAccountId: string | null;
  kind: ExternalConversationChangeKind;
  status: ExternalConversationStatus | null;
  occurredAt: string;
}

export type ExternalEventPayload =
  | {
      type: typeof EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED;
      data: ExternalInboundMessageReceivedPayload;
    }
  | {
      type: typeof EXTERNAL_EVENT_TYPES.OUTBOUND_MESSAGE_ACCEPTED;
      data: ExternalOutboundMessageAcceptedPayload;
    }
  | {
      type: typeof EXTERNAL_EVENT_TYPES.OUTBOUND_MESSAGE_STATUS_CHANGED;
      data: ExternalOutboundMessageStatusChangedPayload;
    }
  | {
      type: typeof EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED;
      data: ExternalConversationChangedPayload;
    };

/**
 * Lookup helper to resolve the payload data type for a given event type.
 * Lets producer code remain strictly typed without `as` casts.
 */
export type ExternalPayloadByType<T extends ExternalEventType> = Extract<
  ExternalEventPayload,
  { type: T }
>["data"];

/**
 * Canonical envelope. Every field is required and non-empty.
 *
 * - `id` is a stable, opaque event identifier (UUIDv4 or comparable) chosen
 *   by the producer. Consumers MUST deduplicate on `id`.
 * - `occurredAt` is the moment the underlying state transition happened, in
 *   RFC 3339 UTC. It is not the publish time.
 * - `recordedAt` is the moment the producer materialized the envelope; it
 *   is informational.
 * - `tenantId` is the sole owner of the event. There is no envelope without
 *   exactly one tenant.
 * - `entities` are the canonical references the consumer can resolve against
 *   the platform's public APIs. The `meta` block is the only place where
 *   producer-side fields are exposed, and they are reference-only.
 */
export interface ExternalEvent<
  TPayload extends ExternalEventPayload = ExternalEventPayload,
> {
  id: string;
  type: TPayload["type"];
  version: typeof EXTERNAL_EVENT_CONTRACT_VERSION;
  tenantId: string;
  occurredAt: string;
  recordedAt: string;
  entities: ExternalEntityRef[];
  meta: {
    /** Producer label, e.g. "core" or a queue dispatcher name. */
    producer: string;
    /** Optional correlation id linking the event to upstream causation. */
    correlationId?: string;
  };
  payload: TPayload["data"];
}

export type AnyExternalEvent = ExternalEvent;

export interface ExternalEventContract {
  version: typeof EXTERNAL_EVENT_CONTRACT_VERSION;
  type: ExternalEventType;
}

export const EXTERNAL_EVENT_CONTRACTS: Record<
  ExternalEventType,
  ExternalEventContract
> = {
  [EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED]: {
    version: EXTERNAL_EVENT_CONTRACT_VERSION,
    type: EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED,
  },
  [EXTERNAL_EVENT_TYPES.OUTBOUND_MESSAGE_ACCEPTED]: {
    version: EXTERNAL_EVENT_CONTRACT_VERSION,
    type: EXTERNAL_EVENT_TYPES.OUTBOUND_MESSAGE_ACCEPTED,
  },
  [EXTERNAL_EVENT_TYPES.OUTBOUND_MESSAGE_STATUS_CHANGED]: {
    version: EXTERNAL_EVENT_CONTRACT_VERSION,
    type: EXTERNAL_EVENT_TYPES.OUTBOUND_MESSAGE_STATUS_CHANGED,
  },
  [EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED]: {
    version: EXTERNAL_EVENT_CONTRACT_VERSION,
    type: EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED,
  },
};
