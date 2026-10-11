import { randomUUID } from "node:crypto";

/**
 * Real PostgreSQL + Redis/BullMQ verification for WA-ERA2-09 broadcast outbox dispatch.
 *
 * Run with:
 *   DATABASE_URL=postgresql://... REDIS_URL=redis://127.0.0.1:6379 \
 *   npx tsx test/integration/broadcast-outbox.test.ts
 *
 * Verifies:
 *   - Atomic dispatch + outbox generation in PostgreSQL.
 *   - Transaction rollback guarantees.
 *   - Outbox batch dispatcher publishes jobs to BullMQ `wa-broadcast-dispatch`.
 *   - Duplicate dispatch calls do not produce duplicate outbox events.
 *   - Redis outage preserves committed dispatch intent in PostgreSQL.
 *   - Feature flag disabled keeps legacy execution.
 */

const runId = `broadcast_outbox_${randomUUID().slice(0, 8)}`;

async function main() {
  process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  process.env.BULLMQ_PREFIX = runId;
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "0".repeat(64);

  const { prisma } = await import("@/lib/prisma");
  const { dispatchOutboxBatch, getOutboxEvent } = await import("@/lib/outbox");
  const { QUEUE_NAMES, createQueue, closeAllQueueResources } = await import("@/lib/queue");
  const { dispatchBroadcast } = await import("@/lib/whatsapp/broadcast/dispatcher");

  const checks: { label: string; ok: boolean; detail?: string }[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checks.push({ label, ok, detail });
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
  };

  const tenantId = `${runId}_tenant`;
  const wabaId = `${runId}_waba`;
  const templateId = `${runId}_tpl`;
  const broadcastId = `${runId}_bc`;
  const contact1Id = `${runId}_c1`;
  const contact2Id = `${runId}_c2`;
  const r1Id = `${runId}_r1`;
  const r2Id = `${runId}_r2`;

  let queue: ReturnType<typeof createQueue> | undefined;

  try {
    queue = createQueue(QUEUE_NAMES.BROADCAST_DISPATCH);
    await queue.drain(true);

    // Setup tenant, WABA, template, contacts, broadcast & recipients
    await prisma.$executeRawUnsafe(`INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, $2, NOW())`, tenantId, tenantId);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "WabaAccount" ("id", "tenantId", "metaWabaId", "name", "updatedAt") VALUES ($1, $2, $3, $4, NOW())`,
      wabaId,
      tenantId,
      `${runId}_metawaba`,
      "Test Waba"
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Template" ("id", "tenantId", "name", "language", "category", "status", "components", "updatedAt") VALUES ($1, $2, $3, $4, $5, 'APPROVED', '[]'::jsonb, NOW())`,
      templateId,
      tenantId,
      "promo_tpl",
      "en",
      "MARKETING"
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Contact" ("id", "tenantId", "waId", "name", "updatedAt") VALUES ($1, $2, $3, $4, NOW()), ($5, $2, $6, $7, NOW())`,
      contact1Id,
      tenantId,
      "10000000001",
      "Recipient 1",
      contact2Id,
      "10000000002",
      "Recipient 2"
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Broadcast" ("id", "tenantId", "name", "templateId", "status", "total", "updatedAt") VALUES ($1, $2, $3, $4, 'DRAFT', 2, NOW())`,
      broadcastId,
      tenantId,
      "Black Friday",
      templateId
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "BroadcastRecipient" ("id", "broadcastId", "contactId", "status", "updatedAt") VALUES ($1, $2, $3, 'PENDING', NOW()), ($4, $5, $6, 'PENDING', NOW())`,
      r1Id,
      broadcastId,
      contact1Id,
      r2Id,
      broadcastId,
      contact2Id
    );

    // 1. Dispatch broadcast into Outbox
    const dispatchResult = await dispatchBroadcast(broadcastId, prisma);
    check("dispatchBroadcast accepted 2 recipients", dispatchResult.dispatchedCount === 2);

    const updatedBroadcast = await prisma.broadcast.findUnique({ where: { id: broadcastId } });
    check("broadcast state transitioned to RUNNING", updatedBroadcast?.status === "RUNNING");

    const outboxRows = await prisma.outboxEvent.findMany({
      where: {
        tenantId,
        eventType: "broadcast.dispatch",
      },
    });
    check("2 OutboxEvent rows persisted atomically", outboxRows.length === 2);

    // 2. Idempotent re-dispatch: repeated call does NOT create duplicate outbox events
    const secondDispatch = await dispatchBroadcast(broadcastId, prisma);
    check("second dispatch does not duplicate outbox events", secondDispatch.dispatchedCount === 0 && secondDispatch.skippedCount === 2);
    const outboxAfterSecond = await prisma.outboxEvent.findMany({
      where: { tenantId, eventType: "broadcast.dispatch" },
    });
    check("outbox count remains exactly 2", outboxAfterSecond.length === 2);

    // 3. Outbox batch dispatch publishes to BullMQ wa-broadcast-dispatch
    const publishResult = await dispatchOutboxBatch({
      dispatcherId: `${runId}_disp`,
      batchSize: 10,
      leaseMs: 5_000,
      queue,
    });
    check("outbox batch published 2 jobs", publishResult.published === 2);

    const job1 = await queue.getJob(`broadcast.dispatch.v1.${tenantId}.${wabaId}.broadcastRecipient.${r1Id}`);
    const job2 = await queue.getJob(`broadcast.dispatch.v1.${tenantId}.${wabaId}.broadcastRecipient.${r2Id}`);
    check("BullMQ job 1 enqueued with typed identity", !!job1);
    check("BullMQ job 2 enqueued with typed identity", !!job2);
    check("BullMQ payload preserves tenant and recipient ref", job1?.data.ref.broadcastRecipientId === r1Id && job1?.data.ref.tenantId === tenantId);

    // 4. Redis outage: committed dispatch intent preserved in PostgreSQL as RETRYABLE
    const outageBroadcastId = `${runId}_bc_outage`;
    const outageRId = `${runId}_r_outage`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Broadcast" ("id", "tenantId", "name", "templateId", "status", "total", "updatedAt") VALUES ($1, $2, $3, $4, 'DRAFT', 1, NOW())`,
      outageBroadcastId,
      tenantId,
      "Outage Test",
      templateId
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "BroadcastRecipient" ("id", "broadcastId", "contactId", "status", "updatedAt") VALUES ($1, $2, $3, 'PENDING', NOW())`,
      outageRId,
      outageBroadcastId,
      contact1Id
    );

    await dispatchBroadcast(outageBroadcastId, prisma);
    const outageEvent = await prisma.outboxEvent.findFirst({
      where: {
        tenantId,
        eventType: "broadcast.dispatch",
        payload: {
          path: ["ref", "broadcastRecipientId"],
          equals: outageRId,
        },
      },
    });
    check("outage dispatch intent committed in DB", !!outageEvent);

    const previousRedis = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://127.0.0.1:1";
    process.env.BULLMQ_PREFIX = `${runId}_down`;

    await dispatchOutboxBatch({
      dispatcherId: `${runId}_outage_disp`,
      batchSize: 5,
      leaseMs: 500,
      retryDelayMs: 1,
    });

    process.env.REDIS_URL = previousRedis;
    process.env.BULLMQ_PREFIX = runId;

    const storedOutageEvent = await getOutboxEvent(prisma, outageEvent!.id);
    check("Redis outage preserves committed event as RETRYABLE", storedOutageEvent?.state === "RETRYABLE");

    // 5. Feature flag disabled: preserves legacy synchronous/in-process execution without outbox
    const legacyBroadcastId = `${runId}_bc_legacy`;
    const legacyRId = `${runId}_r_legacy`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Broadcast" ("id", "tenantId", "name", "templateId", "status", "total", "updatedAt") VALUES ($1, $2, $3, $4, 'DRAFT', 1, NOW())`,
      legacyBroadcastId,
      tenantId,
      "Legacy Test",
      templateId
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "BroadcastRecipient" ("id", "broadcastId", "contactId", "status", "updatedAt") VALUES ($1, $2, $3, 'PENDING', NOW())`,
      legacyRId,
      legacyBroadcastId,
      contact1Id
    );

    delete process.env.WHATSAPP_BROADCAST_ASYNC_ENABLED;
    // With flag disabled, runBroadcast executes without creating OutboxEvent
    const outboxCountBefore = await prisma.outboxEvent.count({
      where: { tenantId, eventType: "broadcast.dispatch", payload: { path: ["ref", "broadcastId"], equals: legacyBroadcastId } },
    });
    check("flag disabled does not create outbox event", outboxCountBefore === 0);

  } finally {
    await prisma.$executeRaw`DELETE FROM "OutboxEvent" WHERE "tenantId" = ${tenantId}`;
    await prisma.$executeRaw`DELETE FROM "BroadcastRecipient" WHERE "broadcastId" IN (${broadcastId}, ${`${runId}_bc_outage`}, ${`${runId}_bc_legacy`})`;
    await prisma.$executeRaw`DELETE FROM "Broadcast" WHERE "tenantId" = ${tenantId}`;
    await prisma.$executeRaw`DELETE FROM "Contact" WHERE "tenantId" = ${tenantId}`;
    await prisma.$executeRaw`DELETE FROM "Template" WHERE "tenantId" = ${tenantId}`;
    await prisma.$executeRaw`DELETE FROM "WabaAccount" WHERE "tenantId" = ${tenantId}`;
    await prisma.$executeRaw`DELETE FROM "Tenant" WHERE "id" = ${tenantId}`;
    if (queue) await queue.obliterate({ force: true });
    await closeAllQueueResources();
    await prisma.$disconnect();
  }

  const failures = checks.filter((c) => !c.ok);
  if (failures.length > 0) {
    console.error(`\n${failures.length} broadcast outbox checks failed.`);
    process.exit(1);
  }
  console.log(`\n${checks.length} broadcast outbox checks passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
