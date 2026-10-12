import { describe, expect, it } from "vitest";
import {
  computeIdempotencyFingerprint,
  isIdempotencyUniqueViolation,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  parseIdempotencyKey,
  type IdempotencyFingerprintInput,
} from "@/lib/idempotency";

function req(key?: string): Request {
  return new Request("http://localhost/api/v1/messages", {
    method: "POST",
    headers: key === undefined ? {} : { "idempotency-key": key },
  });
}

const base: IdempotencyFingerprintInput = {
  tenantId: "tenant_a",
  phoneNumberId: "phone_1",
  conversationId: "conv_1",
  to: "919812345678",
  type: "text",
  text: "Hello",
};

describe("parseIdempotencyKey", () => {
  it("returns null when the header is absent (legacy behavior preserved)", () => {
    expect(parseIdempotencyKey(req())).toBeNull();
  });

  it("accepts and trims a well-formed key", () => {
    expect(parseIdempotencyKey(req("  order-123.abc_XY:9  "))).toBe("order-123.abc_XY:9");
  });

  it("rejects empty keys", () => {
    expect(() => parseIdempotencyKey(req("   "))).toThrow(/must not be empty/);
  });

  it("rejects keys longer than the maximum", () => {
    expect(() => parseIdempotencyKey(req("a".repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1)))).toThrow(
      /at most/,
    );
  });

  it("rejects whitespace and disallowed characters", () => {
    // Node's Headers API rejects control characters before our validator runs,
    // so exercise the regex with ASCII values the transport accepts.
    expect(() => parseIdempotencyKey(req("bad key"))).toThrow(/must contain only/);
    expect(() => parseIdempotencyKey(req("bad/key"))).toThrow(/must contain only/);
    expect(() => parseIdempotencyKey(req("has+plus"))).toThrow(/must contain only/);
  });
});

describe("computeIdempotencyFingerprint", () => {
  it("is stable regardless of object key order (canonical serialization)", () => {
    const reordered: IdempotencyFingerprintInput = {
      type: "text",
      text: "Hello",
      to: "919812345678",
      conversationId: "conv_1",
      phoneNumberId: "phone_1",
      tenantId: "tenant_a",
    };
    expect(computeIdempotencyFingerprint(reordered)).toBe(computeIdempotencyFingerprint(base));
  });

  it("is deterministic across repeated computations (survives process restarts)", () => {
    expect(computeIdempotencyFingerprint(base)).toBe(computeIdempotencyFingerprint({ ...base }));
  });

  it("changes when the recipient changes", () => {
    expect(computeIdempotencyFingerprint({ ...base, to: "919800000000" })).not.toBe(
      computeIdempotencyFingerprint(base),
    );
  });

  it("changes when the channel/account changes", () => {
    expect(computeIdempotencyFingerprint({ ...base, phoneNumberId: "phone_2" })).not.toBe(
      computeIdempotencyFingerprint(base),
    );
  });

  it("changes when the conversation changes", () => {
    expect(computeIdempotencyFingerprint({ ...base, conversationId: "conv_2" })).not.toBe(
      computeIdempotencyFingerprint(base),
    );
  });

  it("changes when the content changes", () => {
    expect(computeIdempotencyFingerprint({ ...base, text: "Goodbye" })).not.toBe(
      computeIdempotencyFingerprint(base),
    );
  });

  it("changes when the message type changes", () => {
    expect(
      computeIdempotencyFingerprint({ ...base, type: "template", template: "order_update" }),
    ).not.toBe(computeIdempotencyFingerprint(base));
  });

  it("ignores undefined fields (no accidental drift)", () => {
    expect(computeIdempotencyFingerprint({ ...base, media: undefined })).toBe(
      computeIdempotencyFingerprint(base),
    );
  });
});

describe("isIdempotencyUniqueViolation", () => {
  it("detects Prisma P2002 and nothing else", () => {
    expect(isIdempotencyUniqueViolation({ code: "P2002" })).toBe(true);
    expect(isIdempotencyUniqueViolation({ code: "P2003" })).toBe(false);
    expect(isIdempotencyUniqueViolation(new Error("boom"))).toBe(false);
    expect(isIdempotencyUniqueViolation(null)).toBe(false);
  });
});
