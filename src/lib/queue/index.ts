/**
 * BullMQ Infrastructure Foundation — Public API.
 *
 * Invariants:
 * - Module import performs NO connection or worker initialization.
 * - Server-side only.
 * - Credentials never exposed in logs or return values.
 */

// Configuration
export {
  QUEUE_NAMES,
  DEFAULT_JOB_OPTIONS,
  QueueConfigurationError,
  getQueueConfig,
} from "./config";
export type { QueueName, QueueConfig } from "./config";

// Contracts
export { JOB_CONTRACT_VERSION, JOB_TYPES, JOB_NAMES, JOB_CONTRACTS } from "./contracts";
export type {
  JobType,
  JobName,
  ProducerIdentity,
  JobReferenceBase,
  PhoneScopedJobReference,
  BaseJobPayload,
  InboundWebhookJobPayload,
  OutboundMessageJobPayload,
  StatusReconciliationJobPayload,
  BroadcastDispatchJobPayload,
  KnownJobPayload,
  JobContract,
} from "./contracts";

// Job builders and validation
export {
  createInboundWebhookJobPayload,
  createOutboundMessageJobPayload,
  createStatusReconciliationJobPayload,
  createBroadcastDispatchJobPayload,
  JobValidationError,
  validateJobPayload,
  getJobContract,
  buildJobIdentity,
  buildJobIdentityForPayload,
} from "./jobs";
export type {
  CreateInboundWebhookJobInput,
  CreateOutboundMessageJobInput,
  CreateStatusReconciliationJobInput,
  CreateBroadcastDispatchJobInput,
  JobIdentity,
  JobIdentityInput,
  JobValidationErrorCode,
} from "./jobs";

// Producers
export { enqueueQueueJob, QueueProducerError } from "./producers";
export type { ProducerErrorCode, EnqueueJobOptions, EnqueueJobResult } from "./producers";

// Connection
export {
  isQueueConfigured,
  getBullMQConnectionOptions,
  createBullMQConnection,
  closeConnection,
  closeAllConnections,
  getTrackedConnectionsCount,
} from "./connection";

// Queue Factory
export {
  createQueue,
  getRegisteredQueue,
  closeQueue,
  closeAllQueues,
  getQueueRegistrySize,
} from "./factory";
export type { CreateQueueOptions } from "./factory";

// Worker Factory
export {
  createWorker,
  closeWorker,
  closeAllWorkers,
  getWorkerRegistrySize,
} from "./worker";
export type { CreateWorkerOptions } from "./worker";

// QueueEvents Factory
export {
  createQueueEvents,
  closeQueueEvents,
  closeAllQueueEvents,
  getEventsRegistrySize,
} from "./events";
export type { CreateQueueEventsOptions } from "./events";

// Operational Inspection
export { inspectQueue } from "./inspection";
export type { QueueInspectionResult, QueueJobCounts } from "./inspection";

// Lifecycle
export { closeAllQueueResources } from "./lifecycle";

// Failure classification
export {
  FAILURE_CATEGORY,
  classifyFailure,
  classifyInfrastructureError,
} from "./failure-classification";
export type { FailureCategory, FailureClassificationResult } from "./failure-classification";

// Retry policy
export { RETRY_POLICIES, isRetryable, computeBackoffDelay, DEFAULT_BULLMQ_JOB_OPTIONS, OUTBOX_BULLMQ_JOB_OPTIONS } from "./retry-policy";
export type { RetryPolicy } from "./retry-policy";
