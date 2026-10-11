import { describe, expect, it } from "vitest";
import { createOutboundMessageJobPayload } from "@/lib/queue";
import { sanitizeFailure, validateOutboxEventInput } from "@/lib/outbox";

const payload = createOutboundMessageJobPayload({
  tenantId: "tenant_1",
  wabaAccountId: "waba_1",
  phoneNumberId: "phone_1",
  conversationId: "conv_1",
  messageId: "msg_1",
  producer: "integration-test",
  enqueuedAt: "2026-10-11T00:00:00.000Z",
});

describe("outbox contracts", () => {
  it("accepts valid queue payloads and preserves tenant references", () => {
    expect(validateOutboxEventInput({ tenantId: "tenant_1", payload })).toEqual(payload);
  });

  it("rejects tenant mismatches and sensitive payloads", () => {
    expect(() => validateOutboxEventInput({ tenantId: "tenant_2", payload })).toThrow(/tenantId/);
    expect(() => validateOutboxEventInput({
      tenantId: "tenant_1",
      payload: { ...payload, accessToken: "secret" } as never,
    })).toThrow(/sensitive/i);
  });

  it("redacts credentials from failure metadata", () => {
    expect(sanitizeFailure(new Error("connect redis://:password@127.0.0.1:6379 failed"))).toMatchObject({
      code: "Error",
      message: "connect redis://[redacted]@127.0.0.1:6379 failed",
    });
  });
});
