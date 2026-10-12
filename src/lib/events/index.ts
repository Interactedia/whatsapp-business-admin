/**
 * ERA 3 — Canonical External Event Contract public surface.
 *
 * Only the types, constants, and validators declared here are considered
 * part of the external contract. Internal helpers (e.g. validation detail
 * accumulation) are intentionally not re-exported.
 */

export {
  EXTERNAL_CONVERSATION_CHANGE_KINDS,
  EXTERNAL_CONVERSATION_STATUSES,
  EXTERNAL_EVENT_CONTRACT_VERSION,
  EXTERNAL_EVENT_CONTRACTS,
  EXTERNAL_EVENT_TYPES,
  EXTERNAL_MESSAGE_STATUSES,
  EXTERNAL_MESSAGE_TYPES,
  type AnyExternalEvent,
  type ExternalConversationChangeKind,
  type ExternalConversationStatus,
  type ExternalEntityKind,
  type ExternalEntityRef,
  type ExternalEvent,
  type ExternalEventContract,
  type ExternalEventPayload,
  type ExternalEventType,
  type ExternalInboundMessageReceivedPayload,
  type ExternalMessageStatus,
  type ExternalMessageType,
  type ExternalOutboundMessageAcceptedPayload,
  type ExternalOutboundMessageStatusChangedPayload,
  type ExternalConversationChangedPayload,
  type ExternalPayloadByType,
} from "./contract";

export {
  ExternalEventValidationError,
  validateExternalEvent,
  validateExternalEventOfType,
  type ExternalEventValidationErrorCode,
} from "./validation";
