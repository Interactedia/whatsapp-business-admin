/**
 * ERA 3 — Canonical External Event runtime validation.
 *
 * Validates unknown input against the canonical envelope contract. Rejects
 * unknown event types, malformed versions, missing tenant ownership, and
 * payloads that include credentials or provider-specific fields that try to
 * define the envelope identity.
 *
 * The validator never returns the input mutating it: it either succeeds and
 * returns a typed value, or throws an `ExternalEventValidationError` with a
 * stable error code and field-level details.
 */

import {
  EXTERNAL_CONVERSATION_CHANGE_KINDS,
  EXTERNAL_CONVERSATION_STATUSES,
  EXTERNAL_EVENT_CONTRACT_VERSION,
  EXTERNAL_EVENT_TYPES,
  EXTERNAL_MESSAGE_STATUSES,
  EXTERNAL_MESSAGE_TYPES,
  type AnyExternalEvent,
  type ExternalEntityKind,
  type ExternalEvent,
  type ExternalEventType,
} from "./contract";

export type ExternalEventValidationErrorCode =
  | "INVALID_PAYLOAD"
  | "UNSUPPORTED_TYPE"
  | "UNSUPPORTED_VERSION"
  | "MISSING_TENANT"
  | "INVALID_IDENTIFIER"
  | "SENSITIVE_FIELD"
  | "INVALID_TIMESTAMP"
  | "INVALID_ENTITY"
  | "INVALID_REFERENCE";

export class ExternalEventValidationError extends Error {
  constructor(
    public readonly code: ExternalEventValidationErrorCode,
    message: string,
    public readonly details: string[] = [],
  ) {
    super(message);
    this.name = "ExternalEventValidationError";
  }
}

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,191}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,191}$/;
const TENANT_ID_PATTERN = ID_PATTERN;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,191}$/;
const PRODUCER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,191}$/;
const PREVIEW_MAX_LENGTH = 280;
const ALLOWED_ENTITY_KINDS: ReadonlySet<ExternalEntityKind> = new Set([
  "tenant",
  "waba",
  "phone",
  "conversation",
  "message",
  "contact",
  "webhook_event",
  "outbox_event",
]);

// ponytail: stable list of substrings; do not rely on a regex for security.
// These names are checked case-insensitively at the top level and one level
// deep inside `payload`/`meta`. The contract does not allow raw provider
// tokens or webhook bodies.
const SENSITIVE_KEY_FRAGMENTS = [
  "token",
  "secret",
  "password",
  "credential",
  "authorization",
  "accesstoken",
  "appsecret",
  "bearer",
  "privatekey",
  "webhookpayload",
  "rawpayload",
  "metapayload",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function isEventType(value: unknown): value is ExternalEventType {
  return (
    typeof value === "string" &&
    (Object.values(EXTERNAL_EVENT_TYPES) as string[]).includes(value)
  );
}

function isEventVersion(value: unknown): value is typeof EXTERNAL_EVENT_CONTRACT_VERSION {
  return value === EXTERNAL_EVENT_CONTRACT_VERSION;
}

function isAllowedStatus(
  value: unknown,
): value is (typeof EXTERNAL_MESSAGE_STATUSES)[number] {
  return (
    typeof value === "string" &&
    (EXTERNAL_MESSAGE_STATUSES as readonly string[]).includes(value)
  );
}

function isAllowedType(
  value: unknown,
): value is (typeof EXTERNAL_MESSAGE_TYPES)[number] {
  return (
    typeof value === "string" &&
    (EXTERNAL_MESSAGE_TYPES as readonly string[]).includes(value)
  );
}

function isAllowedConversationStatus(
  value: unknown,
): value is (typeof EXTERNAL_CONVERSATION_STATUSES)[number] {
  return (
    value === null ||
    (typeof value === "string" &&
      (EXTERNAL_CONVERSATION_STATUSES as readonly string[]).includes(value))
  );
}

function isAllowedChangeKind(
  value: unknown,
): value is (typeof EXTERNAL_CONVERSATION_CHANGE_KINDS)[number] {
  return (
    typeof value === "string" &&
    (EXTERNAL_CONVERSATION_CHANGE_KINDS as readonly string[]).includes(value)
  );
}

function hasSensitiveKey(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const [k, v] of Object.entries(value)) {
    const lower = k.toLowerCase();
    if (SENSITIVE_KEY_FRAGMENTS.some((f) => lower.includes(f))) return true;
    if (hasSensitiveKey(v)) return true;
  }
  return false;
}

function validateIdentifier(
  value: unknown,
  field: string,
  errors: string[],
  pattern: RegExp = ID_PATTERN,
): boolean {
  if (!isNonEmptyString(value)) {
    errors.push(`${field} is required`);
    return false;
  }
  if (!pattern.test(value)) {
    errors.push(`${field} has an invalid format`);
    return false;
  }
  return true;
}

function validateEntity(
  value: unknown,
  errors: string[],
): value is { kind: ExternalEntityKind; id: string; providerId?: string } {
  if (!isRecord(value)) {
    errors.push("entity must be an object");
    return false;
  }
  if (typeof value.kind !== "string" || !ALLOWED_ENTITY_KINDS.has(value.kind as ExternalEntityKind)) {
    errors.push(`entity.kind must be one of: ${Array.from(ALLOWED_ENTITY_KINDS).join(", ")}`);
    return false;
  }
  if (!validateIdentifier(value.id, "entity.id", errors)) return false;
  if (value.providerId !== undefined) {
    if (typeof value.providerId !== "string" || !PROVIDER_ID_PATTERN.test(value.providerId)) {
      errors.push("entity.providerId has an invalid format");
      return false;
    }
  }
  return true;
}

function validatePayload(
  type: ExternalEventType,
  payload: unknown,
  errors: string[],
): boolean {
  if (!isRecord(payload)) {
    errors.push("payload must be an object");
    return false;
  }
  switch (type) {
    case EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED:
      return validateInboundPayload(payload, errors);
    case EXTERNAL_EVENT_TYPES.OUTBOUND_MESSAGE_ACCEPTED:
      return validateOutboundAcceptedPayload(payload, errors);
    case EXTERNAL_EVENT_TYPES.OUTBOUND_MESSAGE_STATUS_CHANGED:
      return validateOutboundStatusPayload(payload, errors);
    case EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED:
      return validateConversationChangedPayload(payload, errors);
    default:
      errors.push("payload type is not supported");
      return false;
  }
}

function validateInboundPayload(
  payload: Record<string, unknown>,
  errors: string[],
): boolean {
  let ok = true;
  ok = validateIdentifier(payload.conversationId, "payload.conversationId", errors) && ok;
  ok = validateIdentifier(payload.messageId, "payload.messageId", errors) && ok;
  ok = validateIdentifier(payload.contactId, "payload.contactId", errors) && ok;
  ok = validateIdentifier(payload.phoneNumberId, "payload.phoneNumberId", errors) && ok;
  ok = validateIdentifier(payload.wabaAccountId, "payload.wabaAccountId", errors) && ok;
  if (!isAllowedType(payload.type)) {
    errors.push(`payload.type must be one of: ${EXTERNAL_MESSAGE_TYPES.join(", ")}`);
    ok = false;
  }
  if (!isIsoDate(payload.receivedAt)) {
    errors.push("payload.receivedAt must be an ISO-8601 string");
    ok = false;
  }
  if (payload.providerMessageId !== undefined) {
    if (typeof payload.providerMessageId !== "string" || !PROVIDER_ID_PATTERN.test(payload.providerMessageId)) {
      errors.push("payload.providerMessageId has an invalid format");
      ok = false;
    }
  }
  if (payload.preview !== undefined) {
    if (typeof payload.preview !== "string" || payload.preview.length > PREVIEW_MAX_LENGTH) {
      errors.push(
        `payload.preview must be a string up to ${PREVIEW_MAX_LENGTH} characters`,
      );
      ok = false;
    }
  }
  return ok;
}

function validateOutboundAcceptedPayload(
  payload: Record<string, unknown>,
  errors: string[],
): boolean {
  let ok = true;
  ok = validateIdentifier(payload.conversationId, "payload.conversationId", errors) && ok;
  ok = validateIdentifier(payload.messageId, "payload.messageId", errors) && ok;
  ok = validateIdentifier(payload.contactId, "payload.contactId", errors) && ok;
  ok = validateIdentifier(payload.phoneNumberId, "payload.phoneNumberId", errors) && ok;
  ok = validateIdentifier(payload.wabaAccountId, "payload.wabaAccountId", errors) && ok;
  if (!isAllowedType(payload.type)) {
    errors.push(`payload.type must be one of: ${EXTERNAL_MESSAGE_TYPES.join(", ")}`);
    ok = false;
  }
  if (!isIsoDate(payload.acceptedAt)) {
    errors.push("payload.acceptedAt must be an ISO-8601 string");
    ok = false;
  }
  if (payload.providerMessageId !== undefined) {
    if (typeof payload.providerMessageId !== "string" || !PROVIDER_ID_PATTERN.test(payload.providerMessageId)) {
      errors.push("payload.providerMessageId has an invalid format");
      ok = false;
    }
  }
  return ok;
}

function validateOutboundStatusPayload(
  payload: Record<string, unknown>,
  errors: string[],
): boolean {
  let ok = true;
  ok = validateIdentifier(payload.conversationId, "payload.conversationId", errors) && ok;
  ok = validateIdentifier(payload.messageId, "payload.messageId", errors) && ok;
  ok = validateIdentifier(payload.phoneNumberId, "payload.phoneNumberId", errors) && ok;
  ok = validateIdentifier(payload.wabaAccountId, "payload.wabaAccountId", errors) && ok;
  if (payload.previousStatus !== null && !isAllowedStatus(payload.previousStatus)) {
    errors.push(
      `payload.previousStatus must be one of: ${EXTERNAL_MESSAGE_STATUSES.join(", ")} or null`,
    );
    ok = false;
  }
  if (!isAllowedStatus(payload.status)) {
    errors.push(`payload.status must be one of: ${EXTERNAL_MESSAGE_STATUSES.join(", ")}`);
    ok = false;
  }
  if (!isIsoDate(payload.changedAt)) {
    errors.push("payload.changedAt must be an ISO-8601 string");
    ok = false;
  }
  if (payload.providerMessageId !== undefined) {
    if (typeof payload.providerMessageId !== "string" || !PROVIDER_ID_PATTERN.test(payload.providerMessageId)) {
      errors.push("payload.providerMessageId has an invalid format");
      ok = false;
    }
  }
  return ok;
}

function validateConversationChangedPayload(
  payload: Record<string, unknown>,
  errors: string[],
): boolean {
  let ok = true;
  ok = validateIdentifier(payload.conversationId, "payload.conversationId", errors) && ok;
  ok = validateIdentifier(payload.contactId, "payload.contactId", errors) && ok;
  if (payload.phoneNumberId !== null) {
    ok = validateIdentifier(payload.phoneNumberId, "payload.phoneNumberId", errors) && ok;
  }
  if (payload.wabaAccountId !== null) {
    ok = validateIdentifier(payload.wabaAccountId, "payload.wabaAccountId", errors) && ok;
  }
  if (!isAllowedChangeKind(payload.kind)) {
    errors.push(
      `payload.kind must be one of: ${EXTERNAL_CONVERSATION_CHANGE_KINDS.join(", ")}`,
    );
    ok = false;
  }
  if (!isAllowedConversationStatus(payload.status)) {
    errors.push(
      `payload.status must be one of: ${EXTERNAL_CONVERSATION_STATUSES.join(", ")} or null`,
    );
    ok = false;
  }
  if (!isIsoDate(payload.occurredAt)) {
    errors.push("payload.occurredAt must be an ISO-8601 string");
    ok = false;
  }
  return ok;
}

/**
 * Validate and coerce an unknown value into a typed `ExternalEvent`. Throws
 * `ExternalEventValidationError` on the first deterministic failure class.
 */
export function validateExternalEvent(input: unknown): AnyExternalEvent {
  if (!isRecord(input)) {
    throw new ExternalEventValidationError(
      "INVALID_PAYLOAD",
      "Event envelope must be an object",
    );
  }

  if (hasSensitiveKey(input)) {
    throw new ExternalEventValidationError(
      "SENSITIVE_FIELD",
      "Event envelope contains a forbidden sensitive field",
      ["envelope or nested object contains a sensitive key"],
    );
  }

  if (!isEventType(input.type)) {
    throw new ExternalEventValidationError(
      "UNSUPPORTED_TYPE",
      `Unsupported event type: ${String(input.type)}`,
    );
  }

  if (!isEventVersion(input.version)) {
    throw new ExternalEventValidationError(
      "UNSUPPORTED_VERSION",
      `Unsupported event version: ${String(input.version)} (expected ${EXTERNAL_EVENT_CONTRACT_VERSION})`,
    );
  }

  const errors: string[] = [];
  if (!validateIdentifier(input.id, "id", errors, EVENT_ID_PATTERN)) {
    throw new ExternalEventValidationError(
      "INVALID_IDENTIFIER",
      "Event id is missing or invalid",
      errors,
    );
  }
  if (!validateIdentifier(input.tenantId, "tenantId", errors, TENANT_ID_PATTERN)) {
    throw new ExternalEventValidationError(
      "MISSING_TENANT",
      "Event must declare exactly one tenant",
      errors,
    );
  }
  if (!isIsoDate(input.occurredAt)) {
    throw new ExternalEventValidationError(
      "INVALID_TIMESTAMP",
      "occurredAt must be an ISO-8601 string",
    );
  }
  if (!isIsoDate(input.recordedAt)) {
    throw new ExternalEventValidationError(
      "INVALID_TIMESTAMP",
      "recordedAt must be an ISO-8601 string",
    );
  }
  if (!Array.isArray(input.entities)) {
    throw new ExternalEventValidationError(
      "INVALID_ENTITY",
      "entities must be an array",
    );
  }
  for (let i = 0; i < input.entities.length; i += 1) {
    if (!validateEntity(input.entities[i], errors)) {
      throw new ExternalEventValidationError(
        "INVALID_ENTITY",
        `entities[${i}] is invalid`,
        errors,
      );
    }
  }
  if (!isRecord(input.meta)) {
    throw new ExternalEventValidationError(
      "INVALID_PAYLOAD",
      "meta must be an object",
    );
  }
  if (!isNonEmptyString(input.meta.producer) || !PRODUCER_PATTERN.test(input.meta.producer)) {
    throw new ExternalEventValidationError(
      "INVALID_PAYLOAD",
      "meta.producer must match [a-z0-9][a-z0-9._:-]{0,63}",
    );
  }
  if (input.meta.correlationId !== undefined) {
    if (
      typeof input.meta.correlationId !== "string" ||
      !CORRELATION_ID_PATTERN.test(input.meta.correlationId)
    ) {
      throw new ExternalEventValidationError(
        "INVALID_REFERENCE",
        "meta.correlationId has an invalid format",
      );
    }
  }

  const payloadErrors: string[] = [];
  if (!validatePayload(input.type, input.payload, payloadErrors)) {
    throw new ExternalEventValidationError(
      "INVALID_PAYLOAD",
      `payload is invalid for type ${input.type}`,
      payloadErrors,
    );
  }

  return input as unknown as AnyExternalEvent;
}

/**
 * Strict validator that additionally constrains the result to a specific
 * event type. Useful for producer code that already knows the type.
 */
export function validateExternalEventOfType<T extends ExternalEventType>(
  input: unknown,
  expectedType: T,
): ExternalEvent {
  const event = validateExternalEvent(input);
  if (event.type !== expectedType) {
    throw new ExternalEventValidationError(
      "UNSUPPORTED_TYPE",
      `Expected event type ${expectedType}, received ${event.type}`,
    );
  }
  return event;
}
