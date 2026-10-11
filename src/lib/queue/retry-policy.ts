/**
 * ERA 2 — Retry policy matrix and backoff configuration.
 *
 * Every queue job uses bounded, explicit retry policies. No infinite retries.
 * Retry decisions are driven by FailureClassificationResult from
 * failure-classification.ts.
 *
 * Backoff is exponential with deterministic jitter source so tests are
 * reproducible. The jitter formula is:
 *   delay_ms = base_delay_ms * 2^(attempt - 1) + deterministic_jitter(attempt, seed)
 *
 * where deterministic_jitter is a simple additive hash so the sequence is
 * reproducible across test runs without random flakiness.
 *
 * Backoff delay budget:
 *   attempt 1: 1000ms  ± deterministic_jitter
 *   attempt 2: 2000ms  ± deterministic_jitter
 *   attempt 3: 4000ms  ± deterministic_jitter
 *
 * This gives a maximum total wait of ~7s for a job that exhausts all attempts.
 */

import { FAILURE_CATEGORY, type FailureCategory } from "./failure-classification";

/** Per-job-type retry configuration. */
export interface RetryPolicy {
  /** Human-readable name for logs and docs. */
  label: string;
  /** Maximum BullMQ job-level attempts (includes initial attempt = 1). */
  maxAttempts: number;
  /** Base delay for exponential backoff (ms). */
  backoffBaseDelayMs: number;
  /** Backoff type. */
  backoffType: "exponential" | "fixed";
}

/**
 * Retry policy by job type.
 *
 * INBOUND_WEBHOOK:     3 attempts, exponential backoff (1000ms base).
 *                      Safe: webhook deduplication via webhookEventId uniqueness.
 *
 * OUTBOUND_MESSAGE:    3 attempts, BUT retry only on SAFE_TRANSIENT or
 *                      INFRASTRUCTURE_UNAVAILABLE. AMBIGUOUS_EXTERNAL
 *                      never triggers BullMQ retry — UNCERTAIN state instead.
 *                      The default 3 is a ceiling; individual handler logic
 *                      controls whether to throw or swallow.
 *
 * STATUS_RECONCILIATION: 3 attempts, exponential backoff. Idempotent on
 *                        webhookEventId + messageId. Out-of-order statuses
 *                        are handled via idempotency checks in reconciliation.
 *
 * BROADCAST_DISPATCH:  3 attempts per recipient, BUT AMBIGUOUS_EXTERNAL
 *                      never triggers BullMQ retry. Recipient idempotency
 *                      is enforced via atomic claim on broadcastRecipientId.
 *
 * OUTBOX_PUBLICATION:  5 attempts (OutboxEvent.maxAttempts). Redis publish
 *                      may be unavailable; publication is safe to retry
 *                      because BullMQ job is only created after successful
 *                      markOutboxPublished.
 */
export const RETRY_POLICIES: Record<string, RetryPolicy> = {
  "inbound.webhook": {
    label: "Inbound Webhook",
    maxAttempts: 3,
    backoffBaseDelayMs: 1_000,
    backoffType: "exponential",
  },
  "outbound.message": {
    label: "Outbound Message",
    maxAttempts: 3,
    backoffBaseDelayMs: 1_000,
    backoffType: "exponential",
  },
  "status.reconciliation": {
    label: "Status Reconciliation",
    maxAttempts: 3,
    backoffBaseDelayMs: 1_000,
    backoffType: "exponential",
  },
  "broadcast.dispatch": {
    label: "Broadcast Dispatch",
    maxAttempts: 3,
    backoffBaseDelayMs: 1_000,
    backoffType: "exponential",
  },
  "outbox.publication": {
    label: "Outbox Publication",
    maxAttempts: 5,
    backoffBaseDelayMs: 5_000,
    backoffType: "exponential",
  },
} as const;

/**
 * Determine whether a FailureCategory triggers BullMQ retry.
 *
 * Returns true only for:
 *   SAFE_TRANSIENT         — safe to retry, no external side effect yet
 *   INFRASTRUCTURE_UNAVAILABLE — transient infra failure, retry when recovered
 *
 * Returns false for:
 *   PERMANENT             — never retry, would fail identically
 *   AMBIGUOUS_EXTERNAL    — NEVER retry, Meta may have accepted the request
 *
 * This function should be called by job processors before deciding whether
 * to throw (trigger BullMQ retry) or swallow (return terminal result).
 */
export function isRetryable(category: FailureCategory): boolean {
  return (
    category === FAILURE_CATEGORY.SAFE_TRANSIENT ||
    category === FAILURE_CATEGORY.INFRASTRUCTURE_UNAVAILABLE
  );
}

/**
 * Compute the backoff delay for a given attempt number.
 *
 * Uses deterministic jitter derived from attempt number and an optional seed
 * so test runs are reproducible:
 *   jitter = (seed * attempt) % 1000  (additive, bounded ±500ms)
 *
 * Formula:
 *   delay = backoffBaseDelayMs * 2^(attempt - 1) + jitter
 *
 * @param attempt  1-based attempt number (1 = first retry after failure)
 * @param baseDelayMs  Base delay from RETRY_POLICIES
 * @param attemptSeed  Deterministic seed (e.g., jobId hash) for jitter
 */
export function computeBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  attemptSeed: number = 0
): number {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const jitter = (attemptSeed * attempt) % 1_000;
  return Math.min(exponential + jitter, 60_000);
}

/**
 * Default BullMQ job options matching the RETRY_POLICIES above.
 * These are applied by createQueue and createWorker factories.
 *
 * @see src/lib/queue/config.ts DEFAULT_JOB_OPTIONS
 */
export const DEFAULT_BULLMQ_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: "exponential" as const,
    delay: 1_000,
  },
  removeOnComplete: {
    count: 1_000,
    age: 24 * 3_600,
  },
  removeOnFail: {
    count: 5_000,
    age: 7 * 24 * 3_600,
  },
} as const;

/**
 * Outbox-specific job options with higher attempt limit.
 */
export const OUTBOX_BULLMQ_JOB_OPTIONS = {
  ...DEFAULT_BULLMQ_JOB_OPTIONS,
  attempts: 5,
  backoff: {
    type: "exponential" as const,
    delay: 5_000,
  },
} as const;
