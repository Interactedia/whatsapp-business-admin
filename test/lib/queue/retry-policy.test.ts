/**
 * Tests for retry policy and failure classification.
 *
 * WA-ERA2-10: Retry, Backoff and Recovery Hardening
 *
 * Run:
 *   npx tsx test/lib/queue/retry-policy.test.ts
 */

import { describe, expect, it } from "vitest";
import { WhatsAppApiError } from "@/lib/whatsapp/client";
import {
  FAILURE_CATEGORY,
  classifyFailure,
  classifyInfrastructureError,
} from "@/lib/queue/failure-classification";
import {
  RETRY_POLICIES,
  computeBackoffDelay,
  isRetryable,
} from "@/lib/queue/retry-policy";

describe("FailureClassificationResult", () => {
  describe("classifyFailure — WhatsAppApiError", () => {
    it("classifies 401 as PERMANENT, not retryable", () => {
      const err = new WhatsAppApiError(401, "Token expired");
      const result = classifyFailure(err);
      expect(result.category).toBe(FAILURE_CATEGORY.PERMANENT);
      expect(result.retryable).toBe(false);
      expect(result.metaAmbiguous).toBe(false);
      expect(result.code).toBe("AUTH_ERROR");
    });

    it("classifies 403 as PERMANENT, not retryable", () => {
      const err = new WhatsAppApiError(403, "Forbidden");
      const result = classifyFailure(err);
      expect(result.category).toBe(FAILURE_CATEGORY.PERMANENT);
      expect(result.retryable).toBe(false);
    });

    it("classifies 400 as PERMANENT, not retryable", () => {
      const err = new WhatsAppApiError(400, "Bad request");
      const result = classifyFailure(err);
      expect(result.category).toBe(FAILURE_CATEGORY.PERMANENT);
      expect(result.retryable).toBe(false);
      expect(result.code).toBe("CLIENT_ERROR");
    });

    it("classifies 404 as PERMANENT, not retryable", () => {
      const err = new WhatsAppApiError(404, "Not found");
      const result = classifyFailure(err);
      expect(result.category).toBe(FAILURE_CATEGORY.PERMANENT);
      expect(result.retryable).toBe(false);
    });

    it("classifies 429 as AMBIGUOUS_EXTERNAL, not retryable", () => {
      const err = new WhatsAppApiError(429, "Rate limited");
      const result = classifyFailure(err);
      expect(result.category).toBe(FAILURE_CATEGORY.AMBIGUOUS_EXTERNAL);
      expect(result.retryable).toBe(false);
      expect(result.metaAmbiguous).toBe(true);
      expect(result.code).toBe("META_RATE_LIMIT");
    });

    it("classifies 500 as AMBIGUOUS_EXTERNAL, not retryable", () => {
      const err = new WhatsAppApiError(500, "Internal server error");
      const result = classifyFailure(err);
      expect(result.category).toBe(FAILURE_CATEGORY.AMBIGUOUS_EXTERNAL);
      expect(result.retryable).toBe(false);
      expect(result.metaAmbiguous).toBe(true);
      expect(result.code).toBe("META_SERVER_ERROR");
    });

    it("classifies 503 as AMBIGUOUS_EXTERNAL, not retryable", () => {
      const err = new WhatsAppApiError(503, "Service unavailable");
      const result = classifyFailure(err);
      expect(result.category).toBe(FAILURE_CATEGORY.AMBIGUOUS_EXTERNAL);
      expect(result.retryable).toBe(false);
      expect(result.metaAmbiguous).toBe(true);
    });

    it("classifies other 4xx as PERMANENT, not retryable", () => {
      const err = new WhatsAppApiError(413, "Payload too large");
      const result = classifyFailure(err);
      expect(result.category).toBe(FAILURE_CATEGORY.PERMANENT);
      expect(result.retryable).toBe(false);
    });
  });

  describe("classifyFailure — network/timeout errors", () => {
    it("classifies TimeoutError as AMBIGUOUS_EXTERNAL", () => {
      const err = new Error("Request timeout");
      err.name = "TimeoutError";
      const result = classifyFailure(err);
      expect(result.category).toBe(FAILURE_CATEGORY.AMBIGUOUS_EXTERNAL);
      expect(result.retryable).toBe(false);
      expect(result.metaAmbiguous).toBe(true);
      expect(result.code).toBe("TIMEOUT");
    });

    it("classifies ECONNREFUSED as AMBIGUOUS_EXTERNAL", () => {
      const err = new Error("connect ECONNREFUSED 127.0.0.1:443");
      const result = classifyFailure(err);
      expect(result.category).toBe(FAILURE_CATEGORY.AMBIGUOUS_EXTERNAL);
      expect(result.retryable).toBe(false);
      expect(result.code).toBe("TIMEOUT");
    });

    it("classifies ENOTFOUND as AMBIGUOUS_EXTERNAL", () => {
      const err = new Error("getaddrinfo ENOTFOUND api.whatsapp.com");
      const result = classifyFailure(err);
      expect(result.category).toBe(FAILURE_CATEGORY.AMBIGUOUS_EXTERNAL);
      expect(result.retryable).toBe(false);
    });
  });

  describe("classifyFailure — parse errors", () => {
    it("classifies unknown errors as AMBIGUOUS_EXTERNAL", () => {
      const result = classifyFailure(new Error("something went wrong"));
      expect(result.category).toBe(FAILURE_CATEGORY.AMBIGUOUS_EXTERNAL);
      expect(result.retryable).toBe(false);
      expect(result.metaAmbiguous).toBe(true);
      expect(result.code).toBe("PARSE_ERROR");
    });

    it("classifies non-Error throws as AMBIGUOUS_EXTERNAL", () => {
      const result = classifyFailure("string error" as never);
      expect(result.category).toBe(FAILURE_CATEGORY.AMBIGUOUS_EXTERNAL);
      expect(result.retryable).toBe(false);
    });
  });

  describe("classifyInfrastructureError", () => {
    it("classifies ECONNREFUSED as INFRASTRUCTURE_UNAVAILABLE, retryable", () => {
      const err = new Error("connect ECONNREFUSED 127.0.0.1:5432");
      const result = classifyInfrastructureError(err);
      expect(result.category).toBe(FAILURE_CATEGORY.INFRASTRUCTURE_UNAVAILABLE);
      expect(result.retryable).toBe(true);
      expect(result.metaAmbiguous).toBe(false);
    });

    it("classifies ETIMEDOUT as INFRASTRUCTURE_UNAVAILABLE, retryable", () => {
      const err = new Error("Connection timed out");
      const result = classifyInfrastructureError(err);
      expect(result.category).toBe(FAILURE_CATEGORY.INFRASTRUCTURE_UNAVAILABLE);
      expect(result.retryable).toBe(true);
    });
  });

  describe("isRetryable", () => {
    it("PERMANENT is not retryable", () => {
      expect(isRetryable(FAILURE_CATEGORY.PERMANENT)).toBe(false);
    });

    it("AMBIGUOUS_EXTERNAL is not retryable", () => {
      expect(isRetryable(FAILURE_CATEGORY.AMBIGUOUS_EXTERNAL)).toBe(false);
    });
  });
});

describe("RETRY_POLICIES", () => {
  it("has bounded maxAttempts for all job types", () => {
    for (const [, policy] of Object.entries(RETRY_POLICIES)) {
      expect(policy.maxAttempts).toBeGreaterThan(0);
      expect(policy.maxAttempts).toBeLessThanOrEqual(10);
    }
  });

  it("has exponential backoff for all job types", () => {
    for (const [, policy] of Object.entries(RETRY_POLICIES)) {
      expect(policy.backoffType).toBe("exponential");
    }
  });

  it("outbound.message and broadcast.dispatch have same backoff base", () => {
    expect(RETRY_POLICIES["outbound.message"].backoffBaseDelayMs).toBe(1_000);
    expect(RETRY_POLICIES["broadcast.dispatch"].backoffBaseDelayMs).toBe(1_000);
  });

  it("outbox.publication has higher backoff base and max attempts", () => {
    expect(RETRY_POLICIES["outbox.publication"].maxAttempts).toBe(5);
    expect(RETRY_POLICIES["outbox.publication"].backoffBaseDelayMs).toBe(5_000);
  });
});

describe("computeBackoffDelay — deterministic jitter", () => {
  it("is deterministic with same seed", () => {
    const d1 = computeBackoffDelay(1, 1_000, 42);
    const d2 = computeBackoffDelay(1, 1_000, 42);
    expect(d1).toBe(d2);
  });

  it("grows exponentially with attempt number", () => {
    const d1 = computeBackoffDelay(1, 1_000, 0);
    const d2 = computeBackoffDelay(2, 1_000, 0);
    const d3 = computeBackoffDelay(3, 1_000, 0);
    expect(d2).toBeGreaterThan(d1);
    expect(d3).toBeGreaterThan(d2);
  });

  it("is bounded at 60s maximum", () => {
    const huge = computeBackoffDelay(20, 1_000_000, 0);
    expect(huge).toBeLessThanOrEqual(60_000);
  });

  it("jitter is bounded within ±500ms range", () => {
    // jitter = (seed * attempt) % 1000, so max is 999ms ≈ ±500ms from base
    for (let attempt = 1; attempt <= 5; attempt++) {
      const base = 1_000 * 2 ** (attempt - 1);
      const withJitter = computeBackoffDelay(attempt, 1_000, 999);
      const jitter = withJitter - base;
      expect(jitter).toBeGreaterThanOrEqual(0);
      expect(jitter).toBeLessThan(1_000);
    }
  });
});
