/**
 * Real Redis producer verification for WA-ERA2-04.
 *
 * Run with:
 *   REDIS_URL=redis://127.0.0.1:6379 npx tsx test/integration/bullmq-producers.test.ts
 */

const testRunId = `wa-producer-test-${Date.now()}`;

async function main() {
  process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  process.env.BULLMQ_PREFIX = testRunId;

  const {
    QUEUE_NAMES,
    closeAllQueueResources,
    createOutboundMessageJobPayload,
    enqueueQueueJob,
    inspectQueue,
    createQueue,
    QueueProducerError,
  } = await import("@/lib/queue");
  const bullmq = await import("bullmq");

  const checks: { label: string; ok: boolean; detail?: string }[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checks.push({ label, ok, detail });
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
  };

  let queue: ReturnType<typeof createQueue> | undefined;

  try {
    queue = createQueue(QUEUE_NAMES.OUTBOUND_MESSAGE);
    const payload = createOutboundMessageJobPayload({
      tenantId: "tenant_A",
      wabaAccountId: "waba_A",
      phoneNumberId: "phone_A",
      conversationId: "conversation_A",
      messageId: "message_A",
      producer: "integration-test",
      enqueuedAt: "2026-10-11T00:00:00.000Z",
    });

    const result = await enqueueQueueJob(payload, { queue });
    check("valid job enqueue succeeds", result.ok && result.queueName === QUEUE_NAMES.OUTBOUND_MESSAGE, result.jobId);

    const job = await queue.getJob(result.jobId);
    check("payload serialization preserves tenant reference", job?.data.ref.tenantId === "tenant_A");
    check("correct queue routing", queue.name === QUEUE_NAMES.OUTBOUND_MESSAGE);

    const duplicateTenantPayload = createOutboundMessageJobPayload({
      ...payload.ref,
      conversationId: "conversation_A",
      messageId: "message_A",
      producer: "integration-test",
      enqueuedAt: "2026-10-11T00:00:00.000Z",
    });
    const differentTenantPayload = createOutboundMessageJobPayload({
      ...payload.ref,
      tenantId: "tenant_B",
      conversationId: "conversation_A",
      messageId: "message_A",
      producer: "integration-test",
      enqueuedAt: "2026-10-11T00:00:00.000Z",
    });
    const sameTenant = await enqueueQueueJob(duplicateTenantPayload, { queue });
    const otherTenant = await enqueueQueueJob(differentTenantPayload, { queue });
    check("same persisted reference has stable identity", sameTenant.jobId === result.jobId);
    check("different tenants do not share identity", otherTenant.jobId !== result.jobId);

    await expectReject(
      enqueueQueueJob({ ...payload, version: 999 }, { queue }),
      (error) => error instanceof QueueProducerError && error.code === "UNSUPPORTED_VERSION",
      "unsupported version rejection",
      check
    );

    await expectReject(
      enqueueQueueJob({ ...payload, ref: { ...payload.ref, tenantId: "" } }, { queue }),
      (error) => error instanceof QueueProducerError && error.code === "INVALID_PAYLOAD",
      "invalid tenant identifier rejection",
      check
    );

    const failingQueue = { add: async () => { throw new Error("synthetic enqueue failure"); } };
    await expectReject(
      enqueueQueueJob(payload, { queue: failingQueue as never }),
      (error) => error instanceof QueueProducerError && error.code === "ENQUEUE_FAILURE",
      "enqueue failure reporting",
      check
    );

    const inspection = await inspectQueue(queue);
    check("isolated queue contains test jobs", inspection.total >= 2, `total=${inspection.total}`);

    await queue.obliterate({ force: true });
    check("isolated queue cleanup succeeds", (await inspectQueue(queue)).total === 0);
    await closeAllQueueResources();
    check("connection cleanup succeeds", true);
    check("BullMQ version visible", typeof bullmq.Queue === "function", "bullmq package loaded");
  } finally {
    if (queue) await queue.obliterate({ force: true }).catch(() => undefined);
    await closeAllQueueResources();
  }

  const failed = checks.filter((entry) => !entry.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} producer integration checks failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${checks.length} producer integration checks passed. Prefix: ${testRunId}`);
  }
}

async function expectReject(
  promise: Promise<unknown>,
  predicate: (error: unknown) => boolean,
  label: string,
  check: (label: string, ok: boolean, detail?: string) => void
) {
  try {
    await promise;
    check(label, false, "resolved unexpectedly");
  } catch (error) {
    check(label, predicate(error), error instanceof Error ? error.message : String(error));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
