/**
 * Real PostgreSQL + Redis/BullMQ verification for WA-ERA2-05 outbox dispatch.
 *
 * Run with:
 *   DATABASE_URL=postgresql://... REDIS_URL=redis://127.0.0.1:6379 npx tsx test/integration/outbox-dispatch.test.ts
 */

const runId = `outbox_dispatch_${Date.now()}`;

async function main() {
  process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  process.env.BULLMQ_PREFIX = runId;

  const { prisma } = await import("@/lib/prisma");
  const { addOutboxEvent, dispatchOutboxBatch, getOutboxEvent } = await import("@/lib/outbox");
  const { QUEUE_NAMES, closeAllQueueResources, createOutboundMessageJobPayload, createQueue } = await import("@/lib/queue");

  const checks: { label: string; ok: boolean; detail?: string }[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checks.push({ label, ok, detail });
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
  };

  const tenantId = `${runId}_tenant`;
  const payload = (messageId: string) => createOutboundMessageJobPayload({
    tenantId,
    wabaAccountId: `${runId}_waba`,
    phoneNumberId: `${runId}_phone`,
    conversationId: `${runId}_conv`,
    messageId,
    producer: "integration-test",
    enqueuedAt: "2026-10-11T00:00:00.000Z",
  });

  let queue: ReturnType<typeof createQueue> | undefined;
  try {
    queue = createQueue(QUEUE_NAMES.OUTBOUND_MESSAGE);
    await queue.drain(true);
    await prisma.$executeRawUnsafe(`INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, $2, NOW())`, tenantId, tenantId);

    const event = await addOutboxEvent(prisma, { tenantId, payload: payload(`${runId}_msg_ok`) });
    const result = await dispatchOutboxBatch({ dispatcherId: `${runId}_dispatcher`, batchSize: 5, leaseMs: 5_000, queue });
    const stored = await getOutboxEvent(prisma, event.id);
    const job = await queue.getJob(`outbound.message.v1.${tenantId}.${runId}_waba.message.${runId}_msg_ok`);
    check("dispatch enqueues BullMQ job", !!job && result.published === 1);
    check("successful publication updates PostgreSQL", stored?.state === "PUBLISHED" && !!stored.publishedAt);
    check("BullMQ payload preserves tenant reference", job?.data.ref.tenantId === tenantId);

    const lostAck = await addOutboxEvent(prisma, { tenantId, payload: payload(`${runId}_msg_lost_ack`) });
    await prisma.$executeRaw`UPDATE "OutboxEvent" SET "state" = 'CLAIMED'::"OutboxPublicationState", "claimedBy" = ${`${runId}_old`}, "claimExpiresAt" = NOW() - INTERVAL '1 second' WHERE "id" = ${lostAck.id}`;
    const recovered = await dispatchOutboxBatch({ dispatcherId: `${runId}_recovery`, batchSize: 5, leaseMs: 5_000, queue });
    const recoveredStored = await getOutboxEvent(prisma, lostAck.id);
    check("lost acknowledgment window is recoverable", recovered.published >= 1 && recoveredStored?.state === "PUBLISHED");

    const unavailable = await addOutboxEvent(prisma, { tenantId, payload: payload(`${runId}_msg_redis_down`) });
    const previousRedis = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://127.0.0.1:1";
    process.env.BULLMQ_PREFIX = `${runId}_down`;
    await dispatchOutboxBatch({ dispatcherId: `${runId}_down`, batchSize: 5, leaseMs: 500, retryDelayMs: 1 });
    process.env.REDIS_URL = previousRedis;
    process.env.BULLMQ_PREFIX = runId;
    const retryable = await getOutboxEvent(prisma, unavailable.id);
    check("Redis failure preserves persisted event", retryable?.state === "RETRYABLE" && retryable.attemptCount === 1);
  } finally {
    await prisma.$executeRaw`DELETE FROM "OutboxEvent" WHERE "tenantId" = ${tenantId}`;
    await prisma.$executeRaw`DELETE FROM "Tenant" WHERE "id" = ${tenantId}`;
    if (queue) await queue.obliterate({ force: true });
    await closeAllQueueResources();
    await prisma.$disconnect();
  }

  const failures = checks.filter((check) => !check.ok);
  if (failures.length) process.exit(1);
  console.log(`\n${checks.length} outbox dispatch checks passed.`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
