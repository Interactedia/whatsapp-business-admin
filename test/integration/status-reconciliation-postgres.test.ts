/**
 * Real PostgreSQL verification for WA-ERA4-06 — Delivery/Read receipt
 * synchronization.
 *
 * Run with:
 *   DATABASE_URL=postgresql://... npx tsx \
 *     test/integration/status-reconciliation-postgres.test.ts
 *
 * This is the authoritative database-level evidence. It exercises
 * `reconcileStatusEvent()` against a real PostgreSQL instance and
 * proves the post-commit canonical authority:
 *
 *   1. A genuine canonical transition (PENDING -> SENT) persists and
 *      the DB row advances.
 *   2. A duplicate webhook does NOT mutate the DB (idempotency).
 *   3. An out-of-order webhook (a stale DELIVERED arriving after READ
 *      is canonical) does NOT regress the DB.
 *   4. A FAILED webhook arriving after DELIVERED/READ is suppressed
 *      by the STATUS_RANK guard.
 *   5. The final canonical state survives a sequence of mixed-order
 *      webhooks.
 *
 * The realtime publication side is covered by the unit test in
 * test/realtime-status-reconciliation.test.ts (with a captured
 * `publish` mock). This integration test focuses on PostgreSQL
 * transactional correctness, which is the durable source of truth
 * for the realtime contract.
 */

import { randomUUID } from "node:crypto";

const runId = `status_pg_${randomUUID().slice(0, 8)}`;

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { reconcileStatusEvent } = await import(
    "@/lib/whatsapp/status/reconciliation"
  );

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

  function buildPayload(providerStatus: string) {
    return {
      object: "whatsapp_business_account",
      entry: [
        {
          id: `${runId}_meta_waba`,
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: metaPhone },
                statuses: [
                  {
                    id: waMsgId,
                    status: providerStatus,
                    timestamp: "1800000000",
                    recipient_id: "5551234",
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  async function currentStatus(): Promise<string | null> {
    const row = await prisma.message.findUnique({
      where: { id: msgId },
      select: { status: true },
    });
    return row?.status ?? null;
  }

  try {
    // Seed: tenant + WABA + phone + conversation + message + attempt
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, $2, NOW())`,
      tenantId, tenantId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "WabaAccount" ("id", "tenantId", "metaWabaId", "name", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      wabaId, tenantId, `${runId}_meta_waba`, "test",
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "PhoneNumber" ("id", "wabaAccountId", "metaPhoneNumberId", "displayPhone", "verifiedName", "updatedAt") VALUES ($1, $2, $3, $4, $5, NOW())`,
      phoneId, wabaId, metaPhone, "+1234567890", "Test",
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Contact" ("id", "waId", "name", "createdAt", "updatedAt") VALUES ($1, $2, $3, NOW(), NOW())`,
      `${runId}_contact`, `${runId}_waid`, "Test",
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Conversation" ("id", "tenantId", "contactId", "phoneNumberId", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      convId, tenantId, `${runId}_contact`, phoneId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Message" ("id", "tenantId", "conversationId", "direction", "type", "status", "waMessageId", "text", "timestamp") VALUES ($1, $2, $3, 'OUT', 'TEXT', 'PENDING', $4, 'hi', NOW())`,
      msgId, tenantId, convId, waMsgId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "OutboundSendAttempt" ("id", "messageId", "tenantId", "waMessageId", "state", "updatedAt") VALUES ($1, $2, $3, $4, 'PENDING', NOW())`,
      `${runId}_attempt`, msgId, tenantId, waMsgId,
    );

    // ---------- A. Real transition: PENDING -> SENT ----------
    {
      const event = await prisma.webhookEvent.create({
        data: {
          payload: buildPayload("sent"),
          signatureValid: true,
          processedOk: false,
          eventSummary: "accepted durable status receipt",
        },
      });
      const r1 = await reconcileStatusEvent({
        webhookEventId: event.id,
        tenantId,
        wabaAccountId: wabaId,
        phoneNumberId: phoneId,
        messageId: msgId,
        waMessageId: waMsgId,
      });
      check("A. result changed", r1.changed === true, `changed=${r1.changed} status=${r1.status}`);
      check("A. result status SENT", r1.status === "SENT");
      const s = await currentStatus();
      check("A. DB row advanced to SENT", s === "SENT", `actual=${s}`);
    }

    // ---------- B. Duplicate webhook: no-op, no DB mutation ----------
    {
      const event = await prisma.webhookEvent.create({
        data: {
          payload: buildPayload("sent"),
          signatureValid: true,
          processedOk: false,
          eventSummary: "accepted durable status receipt",
        },
      });
      const r = await reconcileStatusEvent({
        webhookEventId: event.id,
        tenantId,
        wabaAccountId: wabaId,
        phoneNumberId: phoneId,
        messageId: msgId,
        waMessageId: waMsgId,
      });
      check("B. duplicate not changed", r.changed === false);
      const s = await currentStatus();
      check("B. DB row stays SENT", s === "SENT");
    }

    // ---------- C. SENT -> DELIVERED (advance) ----------
    {
      const event = await prisma.webhookEvent.create({
        data: {
          payload: buildPayload("delivered"),
          signatureValid: true,
          processedOk: false,
          eventSummary: "accepted durable status receipt",
        },
      });
      const r = await reconcileStatusEvent({
        webhookEventId: event.id,
        tenantId,
        wabaAccountId: wabaId,
        phoneNumberId: phoneId,
        messageId: msgId,
        waMessageId: waMsgId,
      });
      check("C. SENT -> DELIVERED changed", r.changed === true);
      const s = await currentStatus();
      check("C. DB row advanced to DELIVERED", s === "DELIVERED");
    }

    // ---------- D. DELIVERED -> READ (advance) ----------
    {
      const event = await prisma.webhookEvent.create({
        data: {
          payload: buildPayload("read"),
          signatureValid: true,
          processedOk: false,
          eventSummary: "accepted durable status receipt",
        },
      });
      const r = await reconcileStatusEvent({
        webhookEventId: event.id,
        tenantId,
        wabaAccountId: wabaId,
        phoneNumberId: phoneId,
        messageId: msgId,
        waMessageId: waMsgId,
      });
      check("D. DELIVERED -> READ changed", r.changed === true);
      const s = await currentStatus();
      check("D. DB row advanced to READ", s === "READ");
    }

    // ---------- E. Stale webhook: a DELIVERED arriving after READ ----------
    {
      const event = await prisma.webhookEvent.create({
        data: {
          payload: buildPayload("delivered"),
          signatureValid: true,
          processedOk: false,
          eventSummary: "accepted durable status receipt",
        },
      });
      const r = await reconcileStatusEvent({
        webhookEventId: event.id,
        tenantId,
        wabaAccountId: wabaId,
        phoneNumberId: phoneId,
        messageId: msgId,
        waMessageId: waMsgId,
      });
      check("E. stale DELIVERED after READ: not changed", r.changed === false);
      const s = await currentStatus();
      check("E. stale DELIVERED after READ: DB stays READ", s === "READ");
    }

    // ---------- F. FAILED after READ: rejected by STATUS_RANK ----------
    {
      const event = await prisma.webhookEvent.create({
        data: {
          payload: buildPayload("failed"),
          signatureValid: true,
          processedOk: false,
          eventSummary: "accepted durable status receipt",
        },
      });
      const r = await reconcileStatusEvent({
        webhookEventId: event.id,
        tenantId,
        wabaAccountId: wabaId,
        phoneNumberId: phoneId,
        messageId: msgId,
        waMessageId: waMsgId,
      });
      check("F. FAILED after READ: not changed", r.changed === false);
      const s = await currentStatus();
      check("F. FAILED after READ: DB stays READ", s === "READ");
    }
  } finally {
    // Cleanup
    await prisma.$executeRawUnsafe(
      `DELETE FROM "OutboundSendAttempt" WHERE "tenantId" = $1`,
      tenantId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "Message" WHERE "tenantId" = $1`,
      tenantId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "Conversation" WHERE "tenantId" = $1`,
      tenantId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "Contact" WHERE "id" = $1`,
      `${runId}_contact`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "PhoneNumber" WHERE "id" = $1`,
      phoneId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "WabaAccount" WHERE "id" = $1`,
      wabaId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "Tenant" WHERE "id" = $1`,
      tenantId,
    );
    await prisma.$disconnect();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
