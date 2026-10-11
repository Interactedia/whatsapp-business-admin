import { randomUUID } from "node:crypto";

/**
 * Real PostgreSQL + Redis/BullMQ verification for WA-ERA2-08 status worker execution.
 *
 * Run with:
 *   DATABASE_URL=postgresql://... REDIS_URL=redis://127.0.0.1:6379 \
 *   npx tsx test/integration/status-worker.test.ts
 */

const runId = `status_worker_${randomUUID().slice(0, 8)}`;

async function main() {
  process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  process.env.BULLMQ_PREFIX = runId;

  const { prisma } = await import("@/lib/prisma");
  const { addOutboxEvent, dispatchOutboxBatch } = await import("@/lib/outbox");
  const {
    QUEUE_NAMES,
    createStatusReconciliationJobPayload,
    createQueue,
    closeAllQueueResources,
  } = await import("@/lib/queue");
  const { createStatusReconciliationWorker } = await import("@/lib/whatsapp/status/worker");
  const { processStatusReconciliationJob } = await import("@/lib/whatsapp/status/processor");

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
  const convId = `${runId}_conv`;
  const msgId = `${runId}_msg`;
  const waMsgId = `wamid.${runId}.1`;

  const statusPayload = (id: string, status = "delivered") => ({
    object: "whatsapp_business_account",
    entry: [{
      id: `${runId}_meta_waba`,
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: metaPhone },
          statuses: [{
            id,
            status,
            timestamp: "1800000000",
            recipient_id: "5551234",
          }],
        },
      }],
    }],
  });

  let worker: ReturnType<typeof createStatusReconciliationWorker> | undefined;

  try {
    await prisma.$executeRawUnsafe(`INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, $2, NOW())`, tenantId, tenantId);
    await prisma.$executeRawUnsafe(`INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, $2, NOW())`, otherTenantId, otherTenantId);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "WabaAccount" ("id", "tenantId", "metaWabaId", "name", "updatedAt") VALUES ($1, $2, $3, $4, NOW())`,
      wabaId,
      tenantId,
      `${runId}_meta_waba`,
      wabaId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "PhoneNumber" ("id", "wabaAccountId", "metaPhoneNumberId", "updatedAt") VALUES ($1, $2, $3, NOW())`,
      phoneId,
      wabaId,
      metaPhone,
    );
    const contactId = `${runId}_contact`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Contact" ("id", "tenantId", "waId", "updatedAt") VALUES ($1, $2, $3, NOW())`,
      contactId,
      tenantId,
      "5551234",
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Conversation" ("id", "tenantId", "contactId", "phoneNumberId", "updatedAt") VALUES ($1, $2, $3, $4, NOW())`,
      convId,
      tenantId,
      contactId,
      phoneId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Message" ("id", "tenantId", "conversationId", "direction", "type", "status", "waMessageId") VALUES ($1, $2, $3, 'OUT', 'TEXT', 'SENT', $4)`,
      msgId,
      tenantId,
      convId,
      waMsgId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "OutboundSendAttempt" ("id", "messageId", "tenantId", "state", "waMessageId", "updatedAt") VALUES ($1, $2, $3, 'SENT', $4, NOW())`,
      `${runId}_attempt`,
      msgId,
      tenantId,
      waMsgId,
    );

    const event = await prisma.webhookEvent.create({
      data: {
        payload: statusPayload(waMsgId, "delivered"),
        signatureValid: true,
        processedOk: false,
        eventSummary: "accepted durable status receipt",
      },
    });

    const jobPayload = createStatusReconciliationJobPayload({
      tenantId,
      wabaAccountId: wabaId,
      phoneNumberId: phoneId,
      messageId: msgId,
      webhookEventId: event.id,
      waMessageId: waMsgId,
      producer: "integration-test",
    });

    const queue = createQueue(QUEUE_NAMES.STATUS_RECONCILIATION);
    await queue.drain(true);

    await addOutboxEvent(prisma, { tenantId, payload: jobPayload });
    const dispatch = await dispatchOutboxBatch({ dispatcherId: `${runId}_dispatcher`, queue });
    check("outbox dispatch published status job", dispatch.published === 1);

    const processed = await new Promise<boolean>((resolve) => {
      worker = createStatusReconciliationWorker({
        concurrency: 1,
        onFailed: (_jobId, err) => {
          console.error("worker error:", err);
          resolve(false);
        },
      });
      worker.on("completed", () => resolve(true));
      setTimeout(() => resolve(false), 10_000);
    });
    check("worker completed status reconciliation", processed);

    const updatedMsg = await prisma.message.findUnique({ where: { id: msgId } });
    check("message updated to DELIVERED", updatedMsg?.status === "DELIVERED");

    // Out-of-order test: SENT arrived after DELIVERED -> message stays DELIVERED
    const sentEvent = await prisma.webhookEvent.create({
      data: {
        payload: statusPayload(waMsgId, "sent"),
        signatureValid: true,
        processedOk: false,
        eventSummary: "accepted durable status receipt",
      },
    });
    await processStatusReconciliationJob({
      ...jobPayload,
      ref: { ...jobPayload.ref, webhookEventId: sentEvent.id },
    });
    const messageAfterSent = await prisma.message.findUnique({ where: { id: msgId } });
    check("out-of-order SENT does not downgrade DELIVERED", messageAfterSent?.status === "DELIVERED");

    // READ event updates status to READ
    const readEvent = await prisma.webhookEvent.create({
      data: {
        payload: statusPayload(waMsgId, "read"),
        signatureValid: true,
        processedOk: false,
        eventSummary: "accepted durable status receipt",
      },
    });
    await processStatusReconciliationJob({
      ...jobPayload,
      ref: { ...jobPayload.ref, webhookEventId: readEvent.id },
    });
    const messageAfterRead = await prisma.message.findUnique({ where: { id: msgId } });
    check("READ event updates status to READ", messageAfterRead?.status === "READ");

    // Cross-tenant test: job targeting other tenant fails ownership
    let crossTenantRejected = false;
    try {
      await processStatusReconciliationJob({
        ...jobPayload,
        ref: { ...jobPayload.ref, tenantId: otherTenantId },
      });
    } catch {
      crossTenantRejected = true;
    }
    check("cross-tenant status update rejected", crossTenantRejected);

  } finally {
    if (worker) await worker.close();
    await closeAllQueueResources();

    await prisma.$executeRawUnsafe(`DELETE FROM "OutboundSendAttempt" WHERE "tenantId" = $1`, tenantId).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM "OutboxEvent" WHERE "tenantId" IN ($1, $2)`, tenantId, otherTenantId).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "tenantId" = $1`, tenantId).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "tenantId" = $1`, tenantId).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "tenantId" = $1`, tenantId).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM "PhoneNumber" WHERE "id" = $1`, phoneId).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM "WabaAccount" WHERE "id" = $1`, wabaId).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" IN ($1, $2)`, tenantId, otherTenantId).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM "WebhookEvent" WHERE "eventSummary" LIKE '%status%' OR "eventSummary" = 'accepted durable status receipt'`).catch(() => {});
    await prisma.$disconnect();
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.error(`status worker integration failed (${failed.length} checks failed)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
