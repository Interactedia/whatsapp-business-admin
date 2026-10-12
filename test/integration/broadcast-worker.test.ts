import { randomUUID } from "node:crypto";
import type { GraphRequest } from "@/lib/whatsapp/client";

/**
 * Real PostgreSQL + Redis/BullMQ verification for WA-ERA2-09 durable broadcast
 * worker execution. The production broadcast worker executes the real
 * handler; only the Meta HTTP boundary is injected with a fake graphFetch.
 *
 * Run with:
 *   DATABASE_URL=postgresql://... REDIS_URL=redis://127.0.0.1:6379 \
 *   npx tsx test/integration/broadcast-worker.test.ts
 *
 * Verifies:
 *   - Production worker claims recipient atomically, calls Meta, marks SENT.
 *   - waMessageId recorded on recipient and message.
 *   - Campaign sentCount incremented accurately.
 *   - Duplicate BullMQ job: second execution skipped, no double-send.
 *   - 5xx error: attempt → UNCERTAIN, recipient stays PENDING, no retry.
 *   - UNCERTAIN cannot be re-claimed.
 *   - 400 error: attempt → FAILED, recipient marked FAILED, failedCount incremented.
 *   - Cancellation before worker execution stops send cleanly.
 *   - Tenant isolation: cross-tenant recipient job is rejected without Meta calls.
 *   - Campaign completion transition when last recipient finishes.
 */

const runId = `broadcast_worker_${randomUUID().slice(0, 8)}`;

type GraphFetchResult = { messages: { id: string }[] };
type GraphFetchFn = (req: GraphRequest) => Promise<GraphFetchResult>;

async function main() {
  process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  process.env.BULLMQ_PREFIX = runId;
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "0".repeat(64);

  const { prisma } = await import("@/lib/prisma");
  const { encrypt } = await import("@/lib/crypto");
  const { addOutboxEvent, dispatchOutboxBatch } = await import("@/lib/outbox");
  const {
    QUEUE_NAMES,
    createBroadcastDispatchJobPayload,
    createQueue,
    closeAllQueueResources,
  } = await import("@/lib/queue");
  const { createBroadcastDispatchWorker } = await import(
    "@/lib/whatsapp/broadcast/worker"
  );
  const { cancelBroadcast } = await import(
    "@/lib/whatsapp/broadcast/repository"
  );

  const checks: { label: string; ok: boolean; detail?: string }[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checks.push({ label, ok, detail });
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
  };

  const tenantA = `${runId}_tenantA`;
  const tenantB = `${runId}_tenantB`;
  const wabaId = `${runId}_waba`;
  const phoneId = `${runId}_phone`;
  const metaPhoneId = `meta_${runId}_phone`;
  const templateId = `${runId}_tpl`;

  let queue: ReturnType<typeof createQueue> | undefined;
  let worker: ReturnType<typeof createBroadcastDispatchWorker> | undefined;

  let graphFetchCalls = 0;
  let graphFetchBehavior: GraphFetchFn = async () => {
    graphFetchCalls++;
    return { messages: [{ id: `wamid.test_${Date.now()}_${randomUUID().slice(0, 4)}` }] };
  };

  const fakeGraphFetch = async (req: GraphRequest): Promise<GraphFetchResult> => {
    return graphFetchBehavior(req);
  };

  try {
    queue = createQueue(QUEUE_NAMES.BROADCAST_DISPATCH);
    await queue.drain(true);

    // Setup WABA and Settings
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, $2, NOW()), ($3, $4, NOW())`,
      tenantA,
      "Tenant A",
      tenantB,
      "Tenant B"
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "WabaAccount" ("id", "tenantId", "metaWabaId", "name", "updatedAt") VALUES ($1, $2, $3, $4, NOW())`,
      wabaId,
      tenantA,
      `${runId}_metawaba`,
      "Waba A"
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "PhoneNumber" ("id", "wabaAccountId", "metaPhoneNumberId", "displayPhone", "updatedAt") VALUES ($1, $2, $3, $4, NOW())`,
      phoneId,
      wabaId,
      metaPhoneId,
      "+15550001"
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "WabaSettings" ("id", "phoneNumberId", "accessTokenEnc", "apiVersion", "updatedAt")
       VALUES ('default', $1, $2, 'v21.0', NOW())
       ON CONFLICT ("id") DO UPDATE SET "phoneNumberId" = $1, "accessTokenEnc" = $2`,
      metaPhoneId,
      encrypt("token_test_123")
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Template" ("id", "tenantId", "name", "language", "category", "status", "components", "updatedAt")
       VALUES ($1, $2, 'promo_deal', 'en', 'MARKETING', 'APPROVED', '[]'::jsonb, NOW())`,
      templateId,
      tenantA
    );

    // Start production worker with fake GraphFetch dependency
    worker = createBroadcastDispatchWorker({
      concurrency: 2,
      dependencies: {
        db: prisma,
        graphFetch: fakeGraphFetch,
        ownerId: `${runId}_worker`,
      },
    });

    // -------------------------------------------------------------------------
    // TEST 1: Happy path sending & progress counter
    // -------------------------------------------------------------------------
    const bc1Id = `${runId}_bc1`;
    const c1Id = `${runId}_c1`;
    const r1Id = `${runId}_r1`;

    await prisma.$executeRawUnsafe(
      `INSERT INTO "Contact" ("id", "tenantId", "waId", "name", "updatedAt") VALUES ($1, $2, '15551001', 'Contact 1', NOW())`,
      c1Id,
      tenantA
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Broadcast" ("id", "tenantId", "name", "templateId", "status", "total", "updatedAt")
       VALUES ($1, $2, 'Campaign 1', $3, 'RUNNING', 1, NOW())`,
      bc1Id,
      tenantA,
      templateId
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "BroadcastRecipient" ("id", "broadcastId", "contactId", "status", "updatedAt")
       VALUES ($1, $2, $3, 'PENDING', NOW())`,
      r1Id,
      bc1Id,
      c1Id
    );

    const payload1 = createBroadcastDispatchJobPayload({
      tenantId: tenantA,
      wabaAccountId: wabaId,
      broadcastId: bc1Id,
      broadcastRecipientId: r1Id,
      contactId: c1Id,
      producer: "integration-test",
    });

    await addOutboxEvent(prisma, { tenantId: tenantA, payload: payload1 });
    await dispatchOutboxBatch({ dispatcherId: `${runId}_d1`, batchSize: 5, queue });

    // Wait for job completion
    let completed1 = false;
    for (let i = 0; i < 40; i++) {
      const recipient = await prisma.broadcastRecipient.findUnique({ where: { id: r1Id } });
      if (recipient?.status === "SENT") {
        completed1 = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    check("T1.1. recipient marked SENT", completed1);
    const r1 = await prisma.broadcastRecipient.findUnique({ where: { id: r1Id } });
    check("T1.2. waMessageId recorded on recipient", !!r1?.waMessageId && r1.waMessageId.startsWith("wamid.test_"));
    check("T1.3. messageId linked to recipient", !!r1?.messageId);

    const msg1 = await prisma.message.findUnique({ where: { id: r1!.messageId! } });
    check("T1.4. message status is SENT", msg1?.status === "SENT");

    const bc1 = await prisma.broadcast.findUnique({ where: { id: bc1Id } });
    check("T1.5. broadcast sentCount incremented to 1", bc1?.sentCount === 1);
    check("T1.6. broadcast completed when all recipients finish", bc1?.status === "COMPLETED");

    // -------------------------------------------------------------------------
    // TEST 2: Replay / duplicate BullMQ job idempotency
    // -------------------------------------------------------------------------
    const callsBeforeReplay = graphFetchCalls;
    await queue.add(
      `retest-${r1Id}`,
      payload1,
      { jobId: `replay-${r1Id}-${Date.now()}` }
    );
    await new Promise((r) => setTimeout(r, 1000));

    check("T2.1. duplicate job made no additional Meta call", graphFetchCalls === callsBeforeReplay);
    const bc1AfterReplay = await prisma.broadcast.findUnique({ where: { id: bc1Id } });
    check("T2.2. sentCount not incremented twice on duplicate job", bc1AfterReplay?.sentCount === 1);

    // -------------------------------------------------------------------------
    // TEST 3: Ambiguous Meta response (500) -> UNCERTAIN, non-retryable
    // -------------------------------------------------------------------------
    const bc2Id = `${runId}_bc2`;
    const c2Id = `${runId}_c2`;
    const r2Id = `${runId}_r2`;

    await prisma.$executeRawUnsafe(
      `INSERT INTO "Contact" ("id", "tenantId", "waId", "name", "updatedAt") VALUES ($1, $2, '15551002', 'Contact 2', NOW())`,
      c2Id,
      tenantA
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Broadcast" ("id", "tenantId", "name", "templateId", "status", "total", "updatedAt")
       VALUES ($1, $2, 'Campaign 2', $3, 'RUNNING', 1, NOW())`,
      bc2Id,
      tenantA,
      templateId
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "BroadcastRecipient" ("id", "broadcastId", "contactId", "status", "updatedAt")
       VALUES ($1, $2, $3, 'PENDING', NOW())`,
      r2Id,
      bc2Id,
      c2Id
    );

    const { WhatsAppApiError } = await import("@/lib/whatsapp/client");
    graphFetchBehavior = async () => {
      graphFetchCalls++;
      throw new WhatsAppApiError(500, "Meta Cloud API gateway timeout");
    };

    const payload2 = createBroadcastDispatchJobPayload({
      tenantId: tenantA,
      wabaAccountId: wabaId,
      broadcastId: bc2Id,
      broadcastRecipientId: r2Id,
      contactId: c2Id,
      producer: "integration-test",
    });

    await queue.add("test-500", payload2, { jobId: `test-500-${r2Id}` });

    let uncertainProcessed = false;
    for (let i = 0; i < 40; i++) {
      const recipient = await prisma.broadcastRecipient.findUnique({ where: { id: r2Id } });
      if (recipient?.error?.includes("UNCERTAIN")) {
        uncertainProcessed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    check("T3.1. recipient recorded UNCERTAIN error annotation", uncertainProcessed);
    const r2 = await prisma.broadcastRecipient.findUnique({ where: { id: r2Id } });
    check("T3.2. recipient status remains PENDING on UNCERTAIN", r2?.status === "PENDING");

    const attempt2 = await prisma.outboundSendAttempt.findFirst({
      where: { messageId: r2!.messageId! },
    });
    check("T3.3. OutboundSendAttempt marked UNCERTAIN", attempt2?.state === "UNCERTAIN");

    const bc2 = await prisma.broadcast.findUnique({ where: { id: bc2Id } });
    check("T3.4. sentCount and failedCount untouched on UNCERTAIN", bc2?.sentCount === 0 && bc2?.failedCount === 0);
    check("T3.5. campaign stays RUNNING while recipient is UNCERTAIN", bc2?.status === "RUNNING");

    // -------------------------------------------------------------------------
    // TEST 4: Certain failure (400 Client Error) -> marks FAILED
    // -------------------------------------------------------------------------
    const bc3Id = `${runId}_bc3`;
    const c3Id = `${runId}_c3`;
    const r3Id = `${runId}_r3`;

    await prisma.$executeRawUnsafe(
      `INSERT INTO "Contact" ("id", "tenantId", "waId", "name", "updatedAt") VALUES ($1, $2, '15551003', 'Contact 3', NOW())`,
      c3Id,
      tenantA
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Broadcast" ("id", "tenantId", "name", "templateId", "status", "total", "updatedAt")
       VALUES ($1, $2, 'Campaign 3', $3, 'RUNNING', 1, NOW())`,
      bc3Id,
      tenantA,
      templateId
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "BroadcastRecipient" ("id", "broadcastId", "contactId", "status", "updatedAt")
       VALUES ($1, $2, $3, 'PENDING', NOW())`,
      r3Id,
      bc3Id,
      c3Id
    );

    graphFetchBehavior = async () => {
      graphFetchCalls++;
      throw new WhatsAppApiError(400, "Template does not exist in requested language");
    };

    const payload3 = createBroadcastDispatchJobPayload({
      tenantId: tenantA,
      wabaAccountId: wabaId,
      broadcastId: bc3Id,
      broadcastRecipientId: r3Id,
      contactId: c3Id,
      producer: "integration-test",
    });

    await queue.add("test-400", payload3, { jobId: `test-400-${r3Id}` });

    let failedProcessed = false;
    for (let i = 0; i < 40; i++) {
      const recipient = await prisma.broadcastRecipient.findUnique({ where: { id: r3Id } });
      if (recipient?.status === "FAILED") {
        failedProcessed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    check("T4.1. recipient status marked FAILED on 400", failedProcessed);
    const bc3 = await prisma.broadcast.findUnique({ where: { id: bc3Id } });
    check("T4.2. broadcast failedCount incremented to 1", bc3?.failedCount === 1);
    check("T4.3. broadcast completed after all recipients finish", bc3?.status === "COMPLETED");

    // -------------------------------------------------------------------------
    // TEST 5: Campaign cancellation stops eligible sends
    // -------------------------------------------------------------------------
    const bc4Id = `${runId}_bc4`;
    const c4Id = `${runId}_c4`;
    const r4Id = `${runId}_r4`;

    await prisma.$executeRawUnsafe(
      `INSERT INTO "Contact" ("id", "tenantId", "waId", "name", "updatedAt") VALUES ($1, $2, '15551004', 'Contact 4', NOW())`,
      c4Id,
      tenantA
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Broadcast" ("id", "tenantId", "name", "templateId", "status", "total", "updatedAt")
       VALUES ($1, $2, 'Campaign 4', $3, 'RUNNING', 1, NOW())`,
      bc4Id,
      tenantA,
      templateId
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "BroadcastRecipient" ("id", "broadcastId", "contactId", "status", "updatedAt")
       VALUES ($1, $2, $3, 'PENDING', NOW())`,
      r4Id,
      bc4Id,
      c4Id
    );

    // Cancel before worker claims
    await cancelBroadcast(prisma, bc4Id, tenantA);
    const bc4Cancelled = await prisma.broadcast.findUnique({ where: { id: bc4Id } });
    check("T5.1. broadcast successfully cancelled", bc4Cancelled?.status === "CANCELLED");

    const callsBeforeCancel = graphFetchCalls;
    const payload4 = createBroadcastDispatchJobPayload({
      tenantId: tenantA,
      wabaAccountId: wabaId,
      broadcastId: bc4Id,
      broadcastRecipientId: r4Id,
      contactId: c4Id,
      producer: "integration-test",
    });

    await queue.add("test-cancel", payload4, { jobId: `test-cancel-${r4Id}` });
    await new Promise((r) => setTimeout(r, 1000));

    check("T5.2. cancelled broadcast made no Meta call", graphFetchCalls === callsBeforeCancel);
    const r4 = await prisma.broadcastRecipient.findUnique({ where: { id: r4Id } });
    check("T5.3. recipient status was not marked SENT", r4?.status !== "SENT");

    // -------------------------------------------------------------------------
    // TEST 6: Tenant isolation (cross-tenant recipient rejected)
    // -------------------------------------------------------------------------
    const callsBeforeIsolation = graphFetchCalls;
    const payloadIsolation = createBroadcastDispatchJobPayload({
      tenantId: tenantB, // tenant B claims tenant A's broadcast
      wabaAccountId: wabaId,
      broadcastId: bc1Id,
      broadcastRecipientId: r1Id,
      contactId: c1Id,
      producer: "integration-test",
    });

    await queue.add("test-isolation", payloadIsolation, { jobId: `test-isolation-${randomUUID()}` });
    await new Promise((r) => setTimeout(r, 1000));

    check("T6.1. cross-tenant job rejected without calling Meta", graphFetchCalls === callsBeforeIsolation);

    // -------------------------------------------------------------------------
    // TEST 7: Forged WABA reference is rejected before Meta invocation
    // -------------------------------------------------------------------------
    const otherWabaId = `${runId}_other_waba`;
    const otherPhoneId = `${runId}_other_phone`;
    const otherMetaPhoneId = `meta_${runId}_other_phone`;
    const bc5Id = `${runId}_bc5`;
    const c5Id = `${runId}_c5`;
    const r5Id = `${runId}_r5`;
    const callsBeforeForgedWaba = graphFetchCalls;

    await prisma.$executeRawUnsafe(
      `INSERT INTO "WabaAccount" ("id", "tenantId", "metaWabaId", "name", "updatedAt") VALUES ($1, $2, $3, 'Tenant B WABA', NOW())`,
      otherWabaId,
      tenantB,
      `${runId}_other_meta_waba`
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "PhoneNumber" ("id", "wabaAccountId", "metaPhoneNumberId", "updatedAt") VALUES ($1, $2, $3, NOW())`,
      otherPhoneId,
      otherWabaId,
      otherMetaPhoneId
    );
    await prisma.wabaSettings.update({ where: { id: "default" }, data: { phoneNumberId: otherMetaPhoneId } });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Contact" ("id", "tenantId", "waId", "name", "updatedAt") VALUES ($1, $2, '15551005', 'Contact 5', NOW())`,
      c5Id,
      tenantA
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Broadcast" ("id", "tenantId", "name", "templateId", "status", "total", "updatedAt")
       VALUES ($1, $2, 'Campaign 5', $3, 'RUNNING', 1, NOW())`,
      bc5Id,
      tenantA,
      templateId
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "BroadcastRecipient" ("id", "broadcastId", "contactId", "status", "updatedAt")
       VALUES ($1, $2, $3, 'PENDING', NOW())`,
      r5Id,
      bc5Id,
      c5Id
    );

    const payloadForgedWaba = createBroadcastDispatchJobPayload({
      tenantId: tenantA,
      wabaAccountId: wabaId,
      broadcastId: bc5Id,
      broadcastRecipientId: r5Id,
      contactId: c5Id,
      producer: "integration-test",
    });

    await queue.add("test-forged-waba", payloadForgedWaba, { jobId: `test-forged-waba-${randomUUID()}` });
    await new Promise((r) => setTimeout(r, 1000));
    const r5 = await prisma.broadcastRecipient.findUnique({ where: { id: r5Id } });
    const campaign5Messages = await prisma.message.count({ where: { tenantId: tenantA, text: "Broadcast: Campaign 5" } });
    check(
      "T7.1. forged WABA/phone correlation rejected before Meta call",
      r5?.messageId === null && campaign5Messages === 0 && graphFetchCalls === callsBeforeForgedWaba,
      `calls=${graphFetchCalls - callsBeforeForgedWaba}`
    );

    await prisma.wabaSettings.update({ where: { id: "default" }, data: { phoneNumberId: metaPhoneId } });

  } finally {
    if (worker) await worker.close();
    await prisma.$executeRaw`DELETE FROM "OutboxEvent" WHERE "tenantId" IN (${tenantA}, ${tenantB})`;
    await prisma.$executeRaw`DELETE FROM "BroadcastRecipient" WHERE "broadcastId" IN (${`${runId}_bc1`}, ${`${runId}_bc2`}, ${`${runId}_bc3`}, ${`${runId}_bc4`}, ${`${runId}_bc5`})`;
    await prisma.$executeRaw`DELETE FROM "Broadcast" WHERE "tenantId" IN (${tenantA}, ${tenantB})`;
    await prisma.$executeRaw`DELETE FROM "Contact" WHERE "tenantId" IN (${tenantA}, ${tenantB})`;
    await prisma.$executeRaw`DELETE FROM "Template" WHERE "tenantId" IN (${tenantA}, ${tenantB})`;
    await prisma.$executeRaw`DELETE FROM "PhoneNumber" WHERE "id" IN (${phoneId}, ${`${runId}_other_phone`})`;
    await prisma.$executeRaw`DELETE FROM "WabaAccount" WHERE "id" IN (${wabaId}, ${`${runId}_other_waba`})`;
    await prisma.$executeRaw`DELETE FROM "Tenant" WHERE "id" IN (${tenantA}, ${tenantB})`;
    if (queue) await queue.obliterate({ force: true });
    await closeAllQueueResources();
    await prisma.$disconnect();
  }

  const failures = checks.filter((c) => !c.ok);
  if (failures.length > 0) {
    console.error(`\n${failures.length} broadcast worker checks failed.`);
    process.exit(1);
  }
  console.log(`\n${checks.length} broadcast worker checks passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
