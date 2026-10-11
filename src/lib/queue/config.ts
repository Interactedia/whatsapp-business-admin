/**
 * Centralized BullMQ configuration.
 *
 * Invariants:
 * - Server-side only: never instantiated during module import.
 * - Credential redaction: credentials never logged or exposed.
 * - Configurable defaults with bounded parameters.
 */

export const QUEUE_NAMES = {
  INBOUND_WEBHOOK: "wa-webhook-inbound",
  OUTBOUND_MESSAGE: "wa-message-outbound",
  STATUS_RECONCILIATION: "wa-status-reconciliation",
  BROADCAST_DISPATCH: "wa-broadcast-dispatch",
} as const;

export type QueueName = typeof QUEUE_NAMES[keyof typeof QUEUE_NAMES];

export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: "exponential" as const,
    delay: 1000,
  },
  removeOnComplete: {
    count: 1000,
    age: 24 * 3600, // 24 hours
  },
  removeOnFail: {
    count: 5000,
    age: 7 * 24 * 3600, // 7 days
  },
};

export class QueueConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueConfigurationError";
  }
}

export interface QueueConfig {
  prefix: string;
  defaultJobOptions: typeof DEFAULT_JOB_OPTIONS;
  defaultWorkerConcurrency: number;
}

export function getQueueConfig(): QueueConfig {
  const prefix = process.env.BULLMQ_PREFIX?.trim() || "wa-queue";
  const concurrency = Math.max(
    1,
    Number(process.env.BULLMQ_WORKER_CONCURRENCY ?? "5")
  );

  return {
    prefix,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
    defaultWorkerConcurrency: concurrency,
  };
}
