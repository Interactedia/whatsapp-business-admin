import {
  EXTERNAL_EVENT_CONTRACT_VERSION,
  EXTERNAL_EVENT_TYPES,
  type AnyExternalEvent,
  type ExternalConversationChangedPayload,
  type ExternalConversationChangeKind,
  type ExternalConversationStatus,
  type ExternalEntityRef,
  type ExternalEventType,
  type ExternalInboundMessageReceivedPayload,
  type ExternalMessageStatus,
  type ExternalMessageType,
  type ExternalOutboundMessageAcceptedPayload,
  type ExternalOutboundMessageStatusChangedPayload,
} from "@/lib/events/contract";
import { validateExternalEvent } from "@/lib/events/validation";

const PRODUCER = "whatsapp-business-admin";
const PREVIEW_LIMIT = 140;

type DateLike = Date | string;

interface EventBaseInput {
  tenantId: string;
  occurredAt: DateLike;
  recordedAt?: DateLike;
  correlationId?: string;
}

interface MessageEntityInput extends EventBaseInput {
  messageId: string;
  conversationId: string;
  contactId?: string;
  phoneNumberId: string;
  wabaAccountId: string;
  providerMessageId?: string | null;
}

export interface InboundMessageReceivedInput extends Required<Pick<MessageEntityInput, "contactId">>, Omit<MessageEntityInput, "contactId"> {
  type: ExternalMessageType;
  preview?: string | null;
}

export interface OutboundMessageAcceptedInput extends Required<Pick<MessageEntityInput, "contactId">>, Omit<MessageEntityInput, "contactId"> {
  type: ExternalMessageType;
}

export interface OutboundMessageStatusChangedInput extends Omit<MessageEntityInput, "contactId"> {
  previousStatus: ExternalMessageStatus | null;
  status: ExternalMessageStatus;
}

export interface ConversationChangedInput extends EventBaseInput {
  conversationId: string;
  contactId: string;
  phoneNumberId: string | null;
  wabaAccountId: string | null;
  kind: ExternalConversationChangeKind;
  status: ExternalConversationStatus | null;
}

export function buildInboundMessageReceivedEvent(input: InboundMessageReceivedInput) {
  const receivedAt = iso(input.occurredAt);
  const payload: ExternalInboundMessageReceivedPayload = {
    conversationId: input.conversationId,
    messageId: input.messageId,
    contactId: input.contactId,
    phoneNumberId: input.phoneNumberId,
    wabaAccountId: input.wabaAccountId,
    type: input.type,
    receivedAt,
    ...(input.providerMessageId ? { providerMessageId: input.providerMessageId } : {}),
    ...preview(input.preview),
  };
  return event({
    id: eventId(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, input.tenantId, input.messageId),
    type: EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED,
    input,
    occurredAt: receivedAt,
    entities: messageEntities(input, true),
    payload,
  });
}

export function buildOutboundMessageAcceptedEvent(input: OutboundMessageAcceptedInput) {
  const acceptedAt = iso(input.occurredAt);
  const payload: ExternalOutboundMessageAcceptedPayload = {
    conversationId: input.conversationId,
    messageId: input.messageId,
    contactId: input.contactId,
    phoneNumberId: input.phoneNumberId,
    wabaAccountId: input.wabaAccountId,
    type: input.type,
    acceptedAt,
    ...(input.providerMessageId ? { providerMessageId: input.providerMessageId } : {}),
  };
  return event({
    id: eventId(EXTERNAL_EVENT_TYPES.OUTBOUND_MESSAGE_ACCEPTED, input.tenantId, input.messageId),
    type: EXTERNAL_EVENT_TYPES.OUTBOUND_MESSAGE_ACCEPTED,
    input,
    occurredAt: acceptedAt,
    entities: messageEntities(input, true),
    payload,
  });
}

export function buildOutboundMessageStatusChangedEvent(input: OutboundMessageStatusChangedInput) {
  if (input.previousStatus === input.status) return null;
  const changedAt = iso(input.occurredAt);
  const payload: ExternalOutboundMessageStatusChangedPayload = {
    conversationId: input.conversationId,
    messageId: input.messageId,
    phoneNumberId: input.phoneNumberId,
    wabaAccountId: input.wabaAccountId,
    previousStatus: input.previousStatus,
    status: input.status,
    changedAt,
    ...(input.providerMessageId ? { providerMessageId: input.providerMessageId } : {}),
  };
  return event({
    id: eventId(
      EXTERNAL_EVENT_TYPES.OUTBOUND_MESSAGE_STATUS_CHANGED,
      input.tenantId,
      input.messageId,
      input.previousStatus ?? "NONE",
      input.status,
    ),
    type: EXTERNAL_EVENT_TYPES.OUTBOUND_MESSAGE_STATUS_CHANGED,
    input,
    occurredAt: changedAt,
    entities: messageEntities(input, false),
    payload,
  });
}

export interface ConversationStatusChangedInput extends Omit<ConversationChangedInput, "kind" | "status"> {
  previousStatus: ExternalConversationStatus | null;
  status: ExternalConversationStatus;
}

export function buildConversationStatusChangedEvent(input: ConversationStatusChangedInput) {
  if (input.previousStatus === input.status) return null;
  return buildConversationChangedEvent({
    ...input,
    kind: "STATUS_CHANGED",
    status: input.status,
  });
}

export function buildConversationChangedEvent(input: ConversationChangedInput) {
  const occurredAt = iso(input.occurredAt);
  const payload = {
    conversationId: input.conversationId,
    contactId: input.contactId,
    phoneNumberId: input.phoneNumberId,
    wabaAccountId: input.wabaAccountId,
    kind: input.kind,
    status: input.status,
    occurredAt,
  };
  return event({
    id: eventId(
      EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED,
      input.tenantId,
      input.conversationId,
      input.kind,
      input.status ?? "NONE",
    ),
    type: EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED,
    input,
    occurredAt,
    entities: conversationEntities(input),
    payload,
  });
}

type ProducerPayload =
  | ExternalInboundMessageReceivedPayload
  | ExternalOutboundMessageAcceptedPayload
  | ExternalOutboundMessageStatusChangedPayload
  | ExternalConversationChangedPayload;

function event(args: {
  id: string;
  type: ExternalEventType;
  input: EventBaseInput;
  occurredAt: string;
  entities: ExternalEntityRef[];
  payload: ProducerPayload;
}): AnyExternalEvent {
  const built: AnyExternalEvent = {
    id: args.id,
    type: args.type,
    version: EXTERNAL_EVENT_CONTRACT_VERSION,
    tenantId: args.input.tenantId,
    occurredAt: args.occurredAt,
    recordedAt: iso(args.input.recordedAt ?? args.input.occurredAt),
    entities: args.entities,
    meta: {
      producer: PRODUCER,
      ...(args.input.correlationId ? { correlationId: args.input.correlationId } : {}),
    },
    payload: args.payload,
  };

  return validateExternalEvent(built);
}

function eventId(type: ExternalEventType, tenantId: string, ...parts: string[]) {
  return ["evt", type, tenantId, ...parts].join(":");
}

function messageEntities(input: MessageEntityInput, includeContact: boolean): ExternalEntityRef[] {
  return compact([
    { kind: "tenant", id: "tenantId" in input ? input.tenantId : "" },
    { kind: "waba", id: input.wabaAccountId },
    { kind: "phone", id: input.phoneNumberId },
    { kind: "conversation", id: input.conversationId },
    { kind: "message", id: input.messageId, ...(input.providerMessageId ? { providerId: input.providerMessageId } : {}) },
    includeContact && input.contactId ? { kind: "contact", id: input.contactId } : null,
  ]);
}

function conversationEntities(input: ConversationChangedInput): ExternalEntityRef[] {
  return compact([
    { kind: "tenant", id: input.tenantId },
    input.wabaAccountId ? { kind: "waba", id: input.wabaAccountId } : null,
    input.phoneNumberId ? { kind: "phone", id: input.phoneNumberId } : null,
    { kind: "conversation", id: input.conversationId },
    { kind: "contact", id: input.contactId },
  ]);
}

function compact(items: Array<ExternalEntityRef | null | false>) {
  return items.filter(Boolean) as ExternalEntityRef[];
}

function preview(value: string | null | undefined) {
  return value ? { preview: value.slice(0, PREVIEW_LIMIT) } : {};
}

function iso(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}
