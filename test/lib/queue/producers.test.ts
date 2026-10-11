import { describe, expect, it, vi } from "vitest";
import { QueueProducerError, createOutboundMessageJobPayload, enqueueQueueJob } from "@/lib/queue";

const payload = createOutboundMessageJobPayload({
  tenantId: "tenant_1",
  wabaAccountId: "waba_1",
  phoneNumberId: "phone_1",
  conversationId: "conv_1",
  messageId: "msg_1",
  producer: "integration-test",
  enqueuedAt: "2026-10-11T00:00:00.000Z",
});

describe("queue producers", () => {
  it("validates payloads before enqueue and returns structured enqueue results", async () => {
    const add = vi.fn().mockResolvedValue({ id: "bullmq-id" });
    const result = await enqueueQueueJob(payload, { queue: { add } as never });

    expect(add).toHaveBeenCalledWith("send-message", payload, {
      jobId: "outbound.message.v1.tenant_1.waba_1.message.msg_1",
    });
    expect(result).toMatchObject({
      ok: true,
      queueName: "wa-message-outbound",
      jobName: "send-message",
      bullmqJobId: "bullmq-id",
    });
  });

  it("propagates validation failures without enqueuing", async () => {
    const add = vi.fn();
    await expect(enqueueQueueJob({ ...payload, version: 99 }, { queue: { add } as never })).rejects.toMatchObject({
      code: "UNSUPPORTED_VERSION",
    });
    expect(add).not.toHaveBeenCalled();
  });

  it("propagates enqueue failures with redacted diagnostics", async () => {
    const add = vi.fn().mockRejectedValue(new Error("connect redis://:password@127.0.0.1:6379 failed"));
    await expect(enqueueQueueJob(payload, { queue: { add } as never })).rejects.toMatchObject({
      code: "ENQUEUE_FAILURE",
      details: ["connect redis://[redacted]@127.0.0.1:6379 failed"],
    } satisfies Partial<QueueProducerError>);
  });
});
