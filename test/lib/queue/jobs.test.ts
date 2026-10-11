import { describe, expect, it } from "vitest";
import {
  JOB_CONTRACT_VERSION,
  JOB_CONTRACTS,
  JOB_TYPES,
  QUEUE_NAMES,
  buildJobIdentityForPayload,
  createBroadcastDispatchJobPayload,
  createInboundWebhookJobPayload,
  createOutboundMessageJobPayload,
  createStatusReconciliationJobPayload,
  validateJobPayload,
  JobValidationError,
} from "@/lib/queue";

const base = {
  tenantId: "tenant_1",
  wabaAccountId: "waba_1",
  phoneNumberId: "phone_1",
  enqueuedAt: "2026-10-11T00:00:00.000Z",
  producer: "integration-test" as const,
};

describe("typed queue job contracts", () => {
  it("defines all four versioned contracts with deterministic queue mapping", () => {
    expect(Object.keys(JOB_CONTRACTS).sort()).toEqual(Object.values(JOB_TYPES).sort());
    expect(JOB_CONTRACTS[JOB_TYPES.INBOUND_WEBHOOK].queueName).toBe(QUEUE_NAMES.INBOUND_WEBHOOK);
    expect(JOB_CONTRACTS[JOB_TYPES.OUTBOUND_MESSAGE].queueName).toBe(QUEUE_NAMES.OUTBOUND_MESSAGE);
    expect(JOB_CONTRACTS[JOB_TYPES.STATUS_RECONCILIATION].queueName).toBe(QUEUE_NAMES.STATUS_RECONCILIATION);
    expect(JOB_CONTRACTS[JOB_TYPES.BROADCAST_DISPATCH].queueName).toBe(QUEUE_NAMES.BROADCAST_DISPATCH);
    expect(Object.values(JOB_CONTRACTS).every((contract) => contract.version === JOB_CONTRACT_VERSION)).toBe(true);
  });

  it("builds minimal reference payloads for every job type", () => {
    const inbound = createInboundWebhookJobPayload({ ...base, webhookEventId: "webhook_1" });
    const outbound = createOutboundMessageJobPayload({ ...base, conversationId: "conv_1", messageId: "msg_1" });
    const status = createStatusReconciliationJobPayload({ ...base, messageId: "msg_1", waMessageId: "wamid.1" });
    const broadcast = createBroadcastDispatchJobPayload({
      tenantId: base.tenantId,
      wabaAccountId: base.wabaAccountId,
      producer: base.producer,
      enqueuedAt: base.enqueuedAt,
      broadcastId: "broadcast_1",
      broadcastRecipientId: "recipient_1",
      contactId: "contact_1",
    });

    expect(inbound.ref.webhookEventId).toBe("webhook_1");
    expect(outbound.ref.messageId).toBe("msg_1");
    expect(status.ref.waMessageId).toBe("wamid.1");
    expect(broadcast.ref.broadcastRecipientId).toBe("recipient_1");
    expect(JSON.stringify([inbound, outbound, status, broadcast])).not.toMatch(/token|secret|password/i);
  });

  it("rejects unsupported versions and missing identifiers", () => {
    const payload = createInboundWebhookJobPayload({ ...base, webhookEventId: "webhook_1" });
    expect(() => validateJobPayload({ ...payload, version: 2 })).toThrow(JobValidationError);
    expect(() => createOutboundMessageJobPayload({ ...base, conversationId: "conv_1", messageId: "" })).toThrow(JobValidationError);
  });

  it("rejects sensitive fields anywhere in the payload", () => {
    const payload = createInboundWebhookJobPayload({ ...base, webhookEventId: "webhook_1" });
    expect(() => validateJobPayload({ ...payload, accessToken: "secret" })).toThrow(JobValidationError);
    expect(() => validateJobPayload({ ...payload, ref: { ...payload.ref, appSecret: "secret" } })).toThrow(JobValidationError);
  });

  it("constructs tenant-scoped deterministic identities without authorization claims", () => {
    const one = createOutboundMessageJobPayload({ ...base, conversationId: "conv_1", messageId: "msg_1" });
    const two = createOutboundMessageJobPayload({ ...base, tenantId: "tenant_2", conversationId: "conv_1", messageId: "msg_1" });

    const idOne = buildJobIdentityForPayload(one);
    const idTwo = buildJobIdentityForPayload(two);

    expect(idOne.jobId).toBe("outbound.message.v1.tenant_1.waba_1.message.msg_1");
    expect(idTwo.jobId).not.toBe(idOne.jobId);
    expect(idOne.limitation).toMatch(/not an exactly-once business guarantee/);
  });
});
