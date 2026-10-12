/**
 * Real PostgreSQL + Redis/BullMQ verification for WA-ERA2-06 inbound worker.
 *
 * Run with:
 *   DATABASE_URL=postgresql://... REDIS_URL=redis://127.0.0.1:6379 npx tsx test/integration/inbound-worker.test.ts
 */

const runId = `inbound_worker_${Date.now()}`;

async function main() {
  process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  process.env.BULLMQ_PREFIX = runId;
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "0".repeat(64);

  const { prisma } = await import("@/lib/prisma");
  const { persistInboundWebhookReceipt } = await import("@/lib/whatsapp/inbound/receipt");
  const { processInboundWebhookJob } = await import("@/lib/whatsapp/inbound/processor");
  const { createInboundWebhookWorker } = await import("@/lib/whatsapp/inbound/worker");
  const { dispatchOutboxBatch } = await import("@/lib/outbox");
  const { QUEUE_NAMES, createQueue, createQueueEvents, closeAllQueueResources } = await import("@/lib/queue");

  const checks: { label: string; ok: boolean; detail?: string }[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checks.push({ label, ok, detail });
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
  };

  const tenantId = `${runId}_tenant`;
  const otherTenantId = `${runId}_tenant_other`;
  const wabaId = `${runId}_waba`;
  const phoneId = `${runId}_phone`;
  const metaPhone = `${runId}_meta_phone`;
  const contactWa = `${Date.now()}5551234`;
  const payload = (messageId: string, body = "hello") => ({
    object: "whatsapp_business_account",
    entry: [{
      id: `${runId}_meta_waba`,
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: metaPhone },
          contacts: [{ wa_id: contactWa, profile: { name: "Inbound Worker Test" } }],
          messages: [{ from: contactWa, id: messageId, timestamp: "1800000000", type: "text", text: { body } }],
        },
      }],
    }],
  });

  let queue: ReturnType<typeof createQueue> | undefined;
  let queueEvents: ReturnType<typeof createQueueEvents> | undefined;

  try {
    queue = createQueue(QUEUE_NAMES.INBOUND_WEBHOOK);
    queueEvents = createQueueEvents(QUEUE_NAMES.INBOUND_WEBHOOK);
    await queue.drain(true);

    await prisma.$executeRawUnsafe(`INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, $2, NOW()), ($3, $4, NOW())`, tenantId, tenantId, otherTenantId, otherTenantId);
    await prisma.$executeRawUnsafe(`INSERT INTO "WabaAccount" ("id", "tenantId", "metaWabaId", "updatedAt") VALUES ($1, $2, $3, NOW())`, wabaId, tenantId, `${runId}_meta_waba`);
    await prisma.$executeRawUnsafe(`INSERT INTO "PhoneNumber" ("id", "wabaAccountId", "metaPhoneNumberId", "displayPhone", "updatedAt") VALUES ($1, $2, $3, $4, NOW())`, phoneId, wabaId, metaPhone, "+10000000000");

    const receipt = await persistInboundWebhookReceipt({ payload: payload(`${runId}_msg_1`), signatureValid: true });
    const dispatcherResult = await dispatchOutboxBatch({ dispatcherId: runId, queue });
    check("outbox dispatch publishes inbound job", dispatcherResult.published === 1, JSON.stringify(dispatcherResult));

    const worker = createInboundWebhookWorker({ concurrency: 1 });
    const waiting = queue.waitUntilReady().then(async () => {
      const jobs = await queue!.getJobs(["waiting", "delayed", "prioritized"]);
      if (!jobs[0]) throw new Error("missing inbound job");
      return jobs[0].waitUntilFinished(queueEvents!, 10_000);
    });
    await waiting.finally(() => worker.close());

    const messageCount = await prisma.message.count({ where: { waMessageId: `${runId}_msg_1`, tenantId } });
    check("worker persists canonical message", messageCount === 1);
    const event = await prisma.webhookEvent.findUnique({ where: { id: receipt.webhookEventId } });
    check("worker marks webhook processed", event?.processedOk === true, event?.eventSummary ?? undefined);

    const jobPayload = {
      type: "inbound.webhook" as const,
      version: 1 as const,
      producer: "integration-test" as const,
      enqueuedAt: new Date().toISOString(),
      ref: { tenantId, wabaAccountId: wabaId, phoneNumberId: phoneId, webhookEventId: receipt.webhookEventId },
    };
    await processInboundWebhookJob(jobPayload);
    const duplicateCount = await prisma.message.count({ where: { waMessageId: `${runId}_msg_1`, tenantId } });
    check("duplicate BullMQ execution is idempotent", duplicateCount === 1);

    await Promise.all([processInboundWebhookJob(jobPayload), processInboundWebhookJob(jobPayload)]);
    const concurrentCount = await prisma.message.count({ where: { waMessageId: `${runId}_msg_1`, tenantId } });
    check("concurrent duplicate execution is idempotent", concurrentCount === 1);

    await processInboundWebhookJob({ ...jobPayload, ref: { ...jobPayload.ref, tenantId: otherTenantId } }).then(
      () => check("cross-tenant worker payload is rejected", false),
      () => check("cross-tenant worker payload is rejected", true),
    );

    const receipt2 = await persistInboundWebhookReceipt({ payload: payload(`${runId}_msg_2`, "after restart"), signatureValid: true });
    await processInboundWebhookJob({ ...jobPayload, ref: { ...jobPayload.ref, webhookEventId: receipt2.webhookEventId } });
    check("worker restart recovery can process persisted event", await prisma.message.count({ where: { waMessageId: `${runId}_msg_2`, tenantId } }) === 1);

    process.env.REDIS_URL = "redis://127.0.0.1:1";
    const receipt3 = await persistInboundWebhookReceipt({ payload: payload(`${runId}_msg_3`, "redis down"), signatureValid: true });
    check("Redis outage does not block committed receipt", !!receipt3.outboxEventId);
  } finally {
    await closeAllQueueResources();
    await prisma.canonicalEventOutbox.deleteMany({ where: { tenantId } });
    await prisma.message.deleteMany({ where: { tenantId } });
    await prisma.conversation.deleteMany({ where: { tenantId } });
    await prisma.contact.deleteMany({ where: { waId: contactWa } });
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.webhookEvent.deleteMany({ where: { eventSummary: { in: ["accepted durable inbound receipt", "duplicate message", "async processing error"] } } });
    await prisma.phoneNumber.deleteMany({ where: { id: phoneId } });
    await prisma.wabaAccount.deleteMany({ where: { id: wabaId } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
    await prisma.$disconnect();
  }

  const failed = checks.filter((result) => !result.ok);
  if (failed.length) {
    console.error(failed);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
