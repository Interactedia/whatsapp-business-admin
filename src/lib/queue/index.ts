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
export { JOB_NAMES } from "./contracts";
export type {
  JobName,
  BaseJobPayload,
  InboundWebhookJobPayload,
  OutboundMessageJobPayload,
  StatusReconciliationJobPayload,
  BroadcastDispatchJobPayload,
  KnownJobPayload,
} from "./contracts";

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
