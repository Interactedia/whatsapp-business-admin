/**
 * Pure classification tests for the auto-retry classifier.
 *
 * These do not touch Postgres or Redis — they verify the matrix of
 * error/condition → AUTO_RETRY / UNCERTAIN / TERMINAL that the scheduler
 * relies on. The invariants are: pre-frontier PARSE_ERROR is AUTO_RETRY,
 * post-frontier PARSE_ERROR is UNCERTAIN, 5xx is UNCERTAIN, 429 with
 * explicit reject is AUTO_RETRY, AUTH/CLIENT errors are TERMINAL.
 */
import { describe, it, expect } from "vitest";
import { classifyError } from "@/lib/whatsapp/outbound/handler";
import { MetaResponseError } from "@/lib/whatsapp/outbound/handler";
import { WhatsAppApiError } from "@/lib/whatsapp/client";

describe("outbound classifyError — auto-retry matrix", () => {
  it("429 with explicit reject → AUTO_RETRY (failed result)", () => {
    const err = new WhatsAppApiError(429, "rate limited", 4, undefined, undefined, undefined, undefined, 60);
    const cls = classifyError(err, false);
    expect(cls.category).toBe("AUTO_RETRY");
    expect(cls.result).toBe("failed");
    expect(cls.autoRetryable).toBe(true);
    expect(cls.retryAfterSeconds).toBe(60);
    expect(cls.errorCode).toBe("META_RATE_LIMIT");
  });

  it("5xx → UNCERTAIN even with Retry-After", () => {
    const err = new WhatsAppApiError(503, "unavailable", undefined, undefined, undefined, undefined, undefined, 90);
    const cls = classifyError(err, true);
    expect(cls.category).toBe("UNCERTAIN");
    expect(cls.autoRetryable).toBe(false);
    expect(cls.retryAfterSeconds).toBe(90);
  });

  it("401/403 → TERMINAL", () => {
    for (const status of [401, 403]) {
      const err = new WhatsAppApiError(status, "auth");
      const cls = classifyError(err, true);
      expect(cls.category).toBe("TERMINAL");
      expect(cls.autoRetryable).toBe(false);
    }
  });

  it("400/404 → TERMINAL", () => {
    for (const status of [400, 404]) {
      const err = new WhatsAppApiError(status, "bad request");
      const cls = classifyError(err, true);
      expect(cls.category).toBe("TERMINAL");
      expect(cls.autoRetryable).toBe(false);
    }
  });

  it("other 4xx (e.g. 409) → TERMINAL", () => {
    const err = new WhatsAppApiError(409, "conflict");
    const cls = classifyError(err, true);
    expect(cls.category).toBe("TERMINAL");
  });

  it("MetaResponseError (200 without wamid) → UNCERTAIN", () => {
    const err = new MetaResponseError("MISSING_MESSAGE_ID", "no wamid");
    const cls = classifyError(err, true);
    expect(cls.category).toBe("UNCERTAIN");
    expect(cls.autoRetryable).toBe(false);
  });

  it("PARSE_ERROR pre-frontier → AUTO_RETRY", () => {
    const err = new Error("fetch failed");
    const cls = classifyError(err, true);
    expect(cls.category).toBe("AUTO_RETRY");
    expect(cls.autoRetryable).toBe(true);
    expect(cls.preFrontier).toBe(true);
  });

  it("PARSE_ERROR post-frontier → UNCERTAIN", () => {
    const err = new Error("fetch failed");
    const cls = classifyError(err, false);
    expect(cls.category).toBe("UNCERTAIN");
    expect(cls.autoRetryable).toBe(false);
    expect(cls.preFrontier).toBe(false);
  });

  it("TIMEOUT pre-frontier → AUTO_RETRY", () => {
    const err = new Error("connect ETIMEDOUT");
    err.name = "TimeoutError";
    const cls = classifyError(err, true);
    expect(cls.category).toBe("AUTO_RETRY");
  });

  it("TIMEOUT post-frontier → UNCERTAIN", () => {
    const err = new Error("connect ETIMEDOUT");
    err.name = "TimeoutError";
    const cls = classifyError(err, false);
    expect(cls.category).toBe("UNCERTAIN");
  });
});
