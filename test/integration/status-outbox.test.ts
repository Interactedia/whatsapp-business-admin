import { randomUUID } from "node:crypto";

/**
 * Real PostgreSQL verification for WA-ERA2-08 status durable receipt.
 *
 * Run with:
 *   DATABASE_URL=postgresql://... npx tsx test/integration/status-outbox.test.ts
 */

const runId = `status_outbox_${randomUUID().slice(0, 8)}`;

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { persistStatusWebhookReceipt, StatusReceiptError } = await import("@/lib/whatsapp/status/receipt");
  const { getOutboxEvent } = await import("@/lib/outbox");
  const { isStatusAsyncEnabled } = await import("@/lib/whatsapp/status/config");

  const checks: { label: string; ok: boolean; detail?: string }[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checks.push({ label, ok, detail });
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
  };

  const tenantId = `${runId}_tenant`;
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

  try {
    check("feature flag defaults disabled", !isStatusAsyncEnabled());

    await prisma.$executeRawUnsafe(`INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, $2, NOW())`, tenantId, tenantId);
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

    const receipt = await persistStatusWebhookReceipt({
      payload: statusPayload(waMsgId, "delivered"),
      signatureValid: true,
    });
    check("receipt returned tenant and outbox", receipt.tenantId === tenantId && receipt.outboxEventIds.length === 1);

    const outbox = await getOutboxEvent(prisma, receipt.outboxEventIds[0]!);
    check("outbox uses typed status.reconciliation contract", outbox?.payload.type === "status.reconciliation" && outbox.payload.ref.waMessageId === waMsgId);

    let rejectedUnknown = false;
    try {
      await persistStatusWebhookReceipt({
        payload: statusPayload("wamid.unknown.999"),
        signatureValid: true,
      });
    } catch (err) {
      rejectedUnknown = err instanceof StatusReceiptError && err.code === "UNKNOWN_MESSAGE";
    }
    check("rejects status receipt for unknown message", rejectedUnknown);

    let rollbackOk = false;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.webhookEvent.create({
          data: {
            payload: statusPayload(waMsgId),
            signatureValid: true,
            processedOk: false,
            eventSummary: "rollback marker",
          },
        });
        throw new Error("forced rollback");
      });
    } catch {
      rollbackOk = true;
    }
    const rolledBack = await prisma.webhookEvent.findFirst({ where: { eventSummary: "rollback marker" } });
    check("rollback test leaves no database residue", rollbackOk && !rolledBack);

  } finally {
    await prisma.$executeRawUnsafe(`DELETE FROM "OutboxEvent" WHERE "tenantId" = $1`, tenantId).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "tenantId" = $1`, tenantId).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "tenantId" = $1`, tenantId).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "tenantId" = $1`, tenantId).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM "PhoneNumber" WHERE "id" = $1`, phoneId).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM "WabaAccount" WHERE "id" = $1`, wabaId).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM "WebhookEvent" WHERE "eventSummary" IN ('accepted durable status receipt', 'rollback marker')`).catch(() => {});
    await prisma.$disconnect();
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.error(`status outbox integration failed (${failed.length} checks failed)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
