/**
 * Real PostgreSQL verification for WA-ERA2-06 inbound durable receipt.
 *
 * Run with:
 *   DATABASE_URL=postgresql://... npx tsx test/integration/inbound-outbox.test.ts
 */

const runId = `inbound_outbox_${Date.now()}`;

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { persistInboundWebhookReceipt } = await import("@/lib/whatsapp/inbound/receipt");
  const { getOutboxEvent } = await import("@/lib/outbox");
  const { isInboundAsyncEnabled } = await import("@/lib/whatsapp/inbound/config");

  const checks: { label: string; ok: boolean; detail?: string }[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checks.push({ label, ok, detail });
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
  };

  const tenantId = `${runId}_tenant`;
  const wabaId = `${runId}_waba`;
  const phoneId = `${runId}_phone`;
  const metaPhone = `${runId}_meta_phone`;
  const payload = (messageId: string) => ({
    object: "whatsapp_business_account",
    entry: [{
      id: `${runId}_meta_waba`,
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: metaPhone },
          contacts: [{ wa_id: `${runId}_contact`, profile: { name: "Inbound Test" } }],
          messages: [{ from: `${runId}_contact`, id: messageId, timestamp: "1800000000", type: "text", text: { body: "hello" } }],
        },
      }],
    }],
  });

  try {
    check("feature flag defaults disabled", !isInboundAsyncEnabled());

    await prisma.$executeRawUnsafe(`INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, $2, NOW())`, tenantId, tenantId);
    await prisma.$executeRawUnsafe(`INSERT INTO "WabaAccount" ("id", "tenantId", "metaWabaId", "updatedAt") VALUES ($1, $2, $3, NOW())`, wabaId, tenantId, `${runId}_meta_waba`);
    await prisma.$executeRawUnsafe(`INSERT INTO "PhoneNumber" ("id", "wabaAccountId", "metaPhoneNumberId", "displayPhone", "updatedAt") VALUES ($1, $2, $3, $4, NOW())`, phoneId, wabaId, metaPhone, "+10000000000");

    const receipt = await persistInboundWebhookReceipt({ payload: payload(`${runId}_msg_1`), signatureValid: true });
    check("receipt persisted webhook event", !!(await prisma.webhookEvent.findUnique({ where: { id: receipt.webhookEventId } })));
    const outbox = await getOutboxEvent(prisma, receipt.outboxEventId);
    check("receipt persisted outbox event", !!outbox && outbox.state === "PENDING", outbox?.state);
    check("outbox uses inbound typed contract", outbox?.payload.type === "inbound.webhook" && outbox.payload.ref.webhookEventId === receipt.webhookEventId);
    check("receipt uses trusted tenant/WABA/phone", receipt.tenantId === tenantId && receipt.wabaAccountId === wabaId && receipt.phoneNumberId === phoneId);

    let rolledBack = false;
    await prisma.$transaction(async (tx) => {
      await tx.webhookEvent.create({ data: { payload: payload(`${runId}_rollback`), signatureValid: true, processedOk: false, eventSummary: "rollback marker" } });
      throw new Error("force rollback");
    }).catch(() => { rolledBack = true; });
    const rolledBackRows = await prisma.webhookEvent.count({ where: { eventSummary: "rollback marker" } });
    check("failed transaction does not persist webhook receipt", rolledBack && rolledBackRows === 0);

    const unknownMeta = { ...payload(`${runId}_unknown`), entry: [{ changes: [{ value: { metadata: { phone_number_id: `${runId}_missing` }, messages: [{ from: "x", id: "x", timestamp: "1800000000", type: "text", text: { body: "x" } }] } }] }] };
    await persistInboundWebhookReceipt({ payload: unknownMeta, signatureValid: true }).then(
      () => check("unknown phone is rejected", false),
      () => check("unknown phone is rejected", true),
    );
  } finally {
    await prisma.canonicalEventOutbox.deleteMany({ where: { tenantId } });
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.webhookEvent.deleteMany({ where: { eventSummary: "accepted durable inbound receipt" } });
    await prisma.phoneNumber.deleteMany({ where: { id: phoneId } });
    await prisma.wabaAccount.deleteMany({ where: { id: wabaId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
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
