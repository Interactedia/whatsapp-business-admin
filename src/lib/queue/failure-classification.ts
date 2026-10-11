/**
 * ERA 2 — Failure classification for BullMQ jobs and queue infrastructure.
 *
 * Failure classification categories:
 *
 *  SAFE_TRANSIENT  — Safe to retry. Repeating the operation cannot create an
 *                    unsafe external side effect (e.g., Meta has not been called).
 *                    The job should be retried with bounded backoff.
 *
 *  PERMANENT       — Non-retryable. Validation, authorization, or business-rule
 *                    failure. Retrying would fail identically. No BullMQ retry.
 *
 *  AMBIGUOUS_EXTERNAL — The external side effect (Meta WhatsApp Cloud API) may
 *                       already have occurred. Retry is UNSAFE because it could
 *                       cause duplicate sends. Status stays PENDING/UNCERTAIN;
 *                       operator must review and explicitly retry.
 *                       BullMQ retries are NEVER triggered.
 *
 *  INFRASTRUCTURE_UNAVAILABLE — Temporary infrastructure failure (Redis, PostgreSQL,
 *                               network). Safe to retry with bounded backoff once
 *                               the dependency recovers.
 *
 * Invariants:
 *  - AMBIGUOUS_EXTERNAL never triggers BullMQ retry.
 *  - PERMANENT never triggers BullMQ retry.
 *  - SAFE_TRANSIENT and INFRASTRUCTURE_UNAVAILABLE trigger bounded BullMQ retry.
 *  - All classifications are deterministic given the same error.
 */

import { WhatsAppApiError } from "@/lib/whatsapp/client";
import type { OutboundErrorCode } from "@/lib/whatsapp/outbound/handler";

/** Failure classification category. */
export const FAILURE_CATEGORY = {
  SAFE_TRANSIENT: "SAFE_TRANSIENT",
  PERMANENT: "PERMANENT",
  AMBIGUOUS_EXTERNAL: "AMBIGUOUS_EXTERNAL",
  INFRASTRUCTURE_UNAVAILABLE: "INFRASTRUCTURE_UNAVAILABLE",
} as const;
export type FailureCategory = (typeof FAILURE_CATEGORY)[keyof typeof FAILURE_CATEGORY];

/**
 * Classification result for a given error.
 * - category: which classification bucket.
 * - retryable: whether BullMQ should retry (true only for SAFE_TRANSIENT /
 *              INFRASTRUCTURE_UNAVAILABLE).
 * - metaAmbiguous: whether Meta may have already accepted the request
 *                  (AMBIGUOUS_EXTERNAL only — used for UNCERTAIN terminal state).
 */
export interface FailureClassificationResult {
  category: FailureCategory;
  retryable: boolean;
  metaAmbiguous: boolean;
  code: OutboundErrorCode;
  message: string;
  metaStatus?: number;
}

/**
 * Classify an error thrown by the Meta WhatsApp Cloud API boundary.
 *
 * Classification matrix:
 *
 *  HTTP 401 / 403          -> PERMANENT        (auth/token invalid — retry would fail)
 *  HTTP 400 / 404          -> PERMANENT        (validation error — retry would fail)
 *  HTTP 429 (rate limit)   -> AMBIGUOUS_EXTERNAL (Meta may have accepted — never retry)
 *  HTTP 5xx                -> AMBIGUOUS_EXTERNAL (server error — may have accepted)
 *  HTTP other 4xx           -> PERMANENT        (client error — retry would fail)
 *  TimeoutError / network  -> AMBIGUOUS_EXTERNAL (request may have arrived)
 *  Missing message ID      -> AMBIGUOUS_EXTERNAL (ambiguous Meta response)
 *  Parse error             -> AMBIGUOUS_EXTERNAL (ambiguous Meta response)
 *
 * Note: MetaAmbiguous outcomes (5xx, 429, timeout) set retryable=false.
 * The Message stays PENDING and OutboundSendAttempt stays UNCERTAIN.
 * Operators must review and explicitly retry; BullMQ never auto-retries.
 */
export function classifyFailure(err: unknown): FailureClassificationResult {
  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof WhatsAppApiError) {
    const status = err.status;

    // Auth / authorization failures — PERMANENT
    if (status === 401 || status === 403) {
      return {
        category: FAILURE_CATEGORY.PERMANENT,
        retryable: false,
        metaAmbiguous: false,
        code: "AUTH_ERROR",
        message,
        metaStatus: status,
      };
    }

    // Validation / not-found — PERMANENT
    if (status === 400 || status === 404) {
      return {
        category: FAILURE_CATEGORY.PERMANENT,
        retryable: false,
        metaAmbiguous: false,
        code: "CLIENT_ERROR",
        message,
        metaStatus: status,
      };
    }

    // Rate limit — AMBIGUOUS_EXTERNAL: Meta may have accepted the request
    if (status === 429) {
      return {
        category: FAILURE_CATEGORY.AMBIGUOUS_EXTERNAL,
        retryable: false,
        metaAmbiguous: true,
        code: "META_RATE_LIMIT",
        message,
        metaStatus: status,
      };
    }

    // 5xx server errors — AMBIGUOUS_EXTERNAL
    if (status >= 500) {
      return {
        category: FAILURE_CATEGORY.AMBIGUOUS_EXTERNAL,
        retryable: false,
        metaAmbiguous: true,
        code: "META_SERVER_ERROR",
        message,
        metaStatus: status,
      };
    }

    // Other 4xx — PERMANENT
    return {
      category: FAILURE_CATEGORY.PERMANENT,
      retryable: false,
      metaAmbiguous: false,
      code: "CLIENT_ERROR",
      message,
      metaStatus: status,
    };
  }

  // Network / timeout errors — AMBIGUOUS_EXTERNAL
  if (
    err instanceof Error &&
    (err.name === "TimeoutError" ||
      /timeout|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(err.message))
  ) {
    return {
      category: FAILURE_CATEGORY.AMBIGUOUS_EXTERNAL,
      retryable: false,
      metaAmbiguous: true,
      code: "TIMEOUT",
      message,
    };
  }

  // Unexpected / parse errors — AMBIGUOUS_EXTERNAL
  return {
    category: FAILURE_CATEGORY.AMBIGUOUS_EXTERNAL,
    retryable: false,
    metaAmbiguous: true,
    code: "PARSE_ERROR",
    message,
  };
}

/**
 * Classify a PostgreSQL or Redis transient infrastructure error.
 * These are always SAFE_TRANSIENT — safe to retry once the dependency recovers.
 */
export function classifyInfrastructureError(err: unknown): FailureClassificationResult {
  const message = err instanceof Error ? err.message : String(err);

  if (
    err instanceof Error &&
    (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|PROTOCOL_CONNECTION_LOST|PG.connect|EADDRINUSE/i.test(
      message
    ))
  ) {
    return {
      category: FAILURE_CATEGORY.INFRASTRUCTURE_UNAVAILABLE,
      retryable: true,
      metaAmbiguous: false,
      code: "TIMEOUT" as OutboundErrorCode,
      message,
    };
  }

  // Default: treat as infrastructure error for safety
  return {
    category: FAILURE_CATEGORY.INFRASTRUCTURE_UNAVAILABLE,
    retryable: true,
    metaAmbiguous: false,
    code: "TIMEOUT" as OutboundErrorCode,
    message,
  };
}
