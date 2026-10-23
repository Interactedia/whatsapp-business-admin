/**
 * WA-OUTRETRY-01 — Auto-retry configuration.
 *
 * - Backoff ladder (seconds): 30, 60, 300, 900 — 4 additional auto-retries max.
 * - Retry-After from Meta is honoured when larger than the ladder step.
 * - Concurrency / polling defaults are conservative; override via env in prod.
 */

export const AUTO_RETRY_BACKOFF_SECONDS = [30, 60, 300, 900] as const;
export const MAX_AUTO_RETRIES = AUTO_RETRY_BACKOFF_SECONDS.length;

export const AUTO_RETRY_SCHEDULER_POLL_MS = Number(
  process.env["OUTBOUND_RETRY_POLL_MS"] ?? 30_000,
);
export const AUTO_RETRY_SCHEDULER_BATCH = Number(
  process.env["OUTBOUND_RETRY_BATCH"] ?? 25,
);
export const AUTO_RETRY_SCHEDULER_DISPATCHER_ID =
  process.env["OUTBOUND_RETRY_DISPATCHER_ID"] ??
  `outbound-retry-scheduler-${process.pid}`;

/**
 * True when the HTTP status is a transient Meta rejection that we are
 * willing to auto-retry (HTTP 429 with explicit reject). 502/503/504 are
 * treated as UNCERTAIN in the classifier — Meta may have already accepted.
 */
export function isMetaRateLimitStatus(status: number | null | undefined): boolean {
  return status === 429;
}
