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
  isValidProviderId,
  validateExternalEvent,
  validateExternalEventOfType,
  type ExternalEventValidationErrorCode,
} from "./validation";
export {
  CanonicalEventOutboxConflictError,
  addCanonicalEvent,
  canonicalEventPayloadHash,
  getCanonicalEvent,
  listCanonicalEvents,
  type CanonicalEventOutboxRecord,
  type CanonicalEventPrisma,
  type ListCanonicalEventsOptions,
} from "./outbox";
export {
  DEFAULT_DELIVERY_BATCH_SIZE,
  DEFAULT_DELIVERY_CONCURRENCY,
  DEFAULT_DELIVERY_TIMEOUT_MS,
  MAX_DELIVERY_BATCH_SIZE,
  MAX_DELIVERY_TIMEOUT_MS,
  MAX_DELIVERY_CONCURRENCY,
  classifyCanonicalDeliveryResult,
  runCanonicalDeliveryWorker,
  deliverCanonicalEventHttp,
  validateCanonicalDestination,
  type CanonicalDeliveryResult,
  type CanonicalDeliveryWorkerOptions,
  type CanonicalDeliveryWorkerResult,
  type CanonicalWebhookDestination,
  type CanonicalHttpTransportOptions,
  type DurableCanonicalDeliveryResult,
} from "./delivery";
export {
  DEFAULT_DELIVERY_LEASE_MS,
  claimDelivery,
  completeDeliveryAttempt,
  createDeliveryForEvent,
  ensureDeliveryRecord,
  getDeliveryRecord,
  listDeliveryAttempts,
  listEligibleDeliveries,
  listSuspendedDeliveriesForDestination,
  resumeDeliveriesForDestination,
  sanitizeDeliveryError,
  suspendDeliveriesForDestination,
  type ClaimedDelivery,
  type ClaimDeliveryOptions,
  type CompleteDeliveryOptions,
  type DeliveryAttemptRecord,
  type DeliveryAttemptResult,
  type DeliveryIdentity,
  type DeliveryRecord,
  type DeliveryState,
  type EnsureDeliveryOptions,
} from "./delivery-state";
export {
  DEFAULT_DELIVERY_BASE_DELAY_MS,
  DEFAULT_DELIVERY_MAX_ATTEMPTS,
  DEFAULT_DELIVERY_MAX_DELAY_MS,
  deliveryPolicy,
  nextRetryDecision,
  retryAfterDelayMs,
  type DeliveryRetryDecision,
  type DeliveryRetryPolicy,
} from "./retry-policy";
export {
  FanoutError,
  MAX_FANOUT_DESTINATIONS_PER_INVOCATION,
  fanoutCanonicalEvent,
  type FanoutCanonicalEventOptions,
  type FanoutDatabase,
  type FanoutDestinationOutcome,
  type FanoutResult,
} from "./fanout";
export {
  MAX_FANOUT_DESTINATIONS_PER_PAGE,
  isSupportedEventType,
  listEligibleWebhookDestinations,
  resolveSuspendedWebhookDeliveries,
  type EligibleFanoutDestination,
  type ListEligibleWebhookDestinationsOptions,
  type ResolveSuspendedResult,
  type ResolveSuspendedStatus,
} from "./webhook-destinations";
