import { randomUUID } from "node:crypto";
import type { GraphRequest } from "@/lib/whatsapp/client";

/**
 * Real PostgreSQL + Redis/BullMQ verification for WA-ERA2-07 durable outbound
 * worker execution. The production outbound worker executes the real
 * handler; only the Meta HTTP boundary is injected with a fake graphFetch.
 *
 * Run with:
 *   DATABASE_URL=postgresql://... REDIS_URL=redis://127.0.0.1:6379 \
 *   npx tsx test/integration/outbound-worker.test.ts
 *
 * Verifies:
 *   - Outbox dispatcher enqueues BullMQ job.
 *   - Worker claims the attempt (durable ownership), calls Meta, marks SENT.
 *   - Duplicate BullMQ job: second claim rejected, no double-send.
 *   - 5xx error: attempt → UNCERTAIN, message stays PENDING, no retry.
 *   - Expired CLAIMED lease after possible Meta send is not re-claimed.
 *   - UNCERTAIN is non-retryable even after lease expiry.
 *   - Tenant isolation: outbox event for a different tenant is rejected.
 */

const runId = `outbound_worker_${randomUUID().slice(0, 8)}`;

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
    createOutboundMessageJobPayload,
    createQueue,
    closeAllQueueResources,
  } = await import("@/lib/queue");
  const { createOutboundMessageWorker } = await import("@/lib/whatsapp/outbound/worker");
  const { claimOutboundAttempt } = await import("@/lib/whatsapp/outbound/repository");
  const { WhatsAppApiError } = await import("@/lib/whatsapp/client");

  // Mutable graphFetch — the test changes its mode per scenario.
  const metaCalls: GraphRequest[] = [];
  const graphFetchMock: { fn: GraphFetchFn } = {
    fn: async () => ({ messages: [{ id: "wamid.integration.test" }] }),
  };
  const graphFetch = async (req: GraphRequest): Promise<GraphFetchResult> => {
    metaCalls.push(req);
    return graphFetchMock.fn(req);
  };

  const checks: { label: string; ok: boolean; detail?: string }[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checks.push({ label, ok, detail });
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
  };

  const tenantId = `${runId}_tenant`;
  const tenantB = `${runId}_tenantB`;
  const wabaId = `${runId}_waba`;
  const phoneId = `${runId}_phone`;
  const convId = `${runId}_conv`;
  const contactId = `${runId}_contact`;

  let queue: ReturnType<typeof createQueue> | undefined;
  let worker: ReturnType<typeof createOutboundMessageWorker> | undefined;
  try {
    // ---- Seed ----
    // Clean up any leftover rows from previous failed runs (by tenantId).
    await prisma.$executeRawUnsafe(`DELETE FROM "OutboundSendAttempt" WHERE "tenantId" LIKE 'outbound_worker_%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "OutboxEvent" WHERE "tenantId" LIKE 'outbound_worker_%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "id" LIKE 'outbound_worker_%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "id" LIKE 'outbound_worker_%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "id" LIKE 'outbound_worker_%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "PhoneNumber" WHERE "id" LIKE 'outbound_worker_%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "WabaAccount" WHERE "id" LIKE 'outbound_worker_%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" LIKE 'outbound_worker_%'`);
    console.log("post-cleanup messages:", await prisma.$queryRawUnsafe<{ count: string }[]>(`SELECT COUNT(*)::text FROM "Message" WHERE id LIKE 'outbound_worker_%'`).catch(() => [{ count: "err" }]));

    await prisma.$executeRawUnsafe(
      `INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, $2, NOW()), ($3, $4, NOW())`,
      tenantId, tenantId, tenantB, tenantB
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "WabaAccount" ("id", "tenantId", "metaWabaId", "name", "accessTokenEnc", "apiVersion", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, 'v21.0', NOW(), NOW())`,
      wabaId, tenantId, `${runId}_meta_waba`, "test", encrypt("test-token")
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "PhoneNumber" ("id", "wabaAccountId", "metaPhoneNumberId", "displayPhone", "verifiedName", "updatedAt") VALUES ($1, $2, $3, $4, $5, NOW())`,
      phoneId, wabaId, "111111111", "+1234567890", "Test"
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Contact" ("id", "waId", "name", "createdAt", "updatedAt") VALUES ($1, $2, $3, NOW(), NOW())`,
      contactId, `919${Date.now() % 100000000}`, "Test"
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Conversation" ("id", "tenantId", "contactId", "phoneNumberId", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      convId, tenantId, contactId, phoneId
    );

    queue = createQueue(QUEUE_NAMES.OUTBOUND_MESSAGE);
    await queue.drain(true);
    // Also obliterate any stale jobs from previous runs
    await queue.obliterate({ force: true }).catch(() => {});
    worker = createOutboundMessageWorker({ concurrency: 1, dependencies: { graphFetch } });
    await worker.waitUntilReady();
    // Give the worker a moment to attach.
    await new Promise((r) => setTimeout(r, 500));

    const createMessageAndDispatch = async (messageId: string, targetTenant: string) => {
      if (process.env.DEBUG_TEST) console.log("[test] createMessageAndDispatch", messageId, targetTenant);
      // First clean up any leftover rows for this messageId.
      await prisma.$executeRawUnsafe(`DELETE FROM "OutboundSendAttempt" WHERE "messageId" = $1`, messageId).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "id" = $1`, messageId).catch(() => {});
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Message" ("id", "tenantId", "conversationId", "direction", "type", "status", "text", "timestamp") VALUES ($1, $2, $3, 'OUT', 'TEXT', 'PENDING', 'hi', NOW())`,
        messageId, targetTenant, convId
      );
      const payload = createOutboundMessageJobPayload({
        tenantId: targetTenant,
        wabaAccountId: wabaId,
        phoneNumberId: phoneId,
        conversationId: convId,
        messageId,
        producer: "integration-test",
      });
      await prisma.$transaction(async (tx) => {
        await tx.outboundSendAttempt.create({
          data: { messageId, tenantId: targetTenant, state: "PENDING" },
        });
        await addOutboxEvent(tx, { tenantId: targetTenant, payload });
      });
      const r = await dispatchOutboxBatch({ dispatcherId: runId, batchSize: 5, leaseMs: 5_000, queue });
      return r;
    };

    const waitForState = async (messageId: string, expected: string, timeoutMs = 15_000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const row = await prisma.message.findUnique({ where: { id: messageId } });
        if (row?.status === expected) return row;
        await new Promise((r) => setTimeout(r, 100));
      }
      const row = await prisma.message.findUnique({ where: { id: messageId } });
      throw new Error(`Timeout waiting for ${messageId} to reach ${expected}; actual=${row?.status}`);
    };

    const waitForAttemptState = async (messageId: string, expected: string, tenant = tenantId, timeoutMs = 15_000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const a = await prisma.outboundSendAttempt.findFirst({
          where: { messageId, tenantId: tenant },
          orderBy: { createdAt: "desc" },
        });
        if (a?.state === expected) return a;
        await new Promise((r) => setTimeout(r, 100));
      }
      const a = await prisma.outboundSendAttempt.findFirst({
        where: { messageId, tenantId: tenant },
        orderBy: { createdAt: "desc" },
      });
      throw new Error(`Timeout waiting for attempt(${messageId}) to reach ${expected}; actual=${a?.state}`);
    };

    // ---- T1. Success ----
    graphFetchMock.fn = async () => ({ messages: [{ id: "wamid.t1.ok" }] });
    const m1 = `${runId}_msg_ok`;
    const dispatch1 = await createMessageAndDispatch(m1, tenantId);
    check("T1.1. outbox dispatch published job", dispatch1.published === 1);
    await waitForState(m1, "SENT");
    const m1Final = await prisma.message.findUnique({ where: { id: m1 } });
    check("T1.2. message SENT", m1Final?.status === "SENT");
    check("T1.3. waMessageId recorded", m1Final?.waMessageId === "wamid.t1.ok");
    const a1 = await waitForAttemptState(m1, "SENT");
    check("T1.4. attempt SENT", a1.state === "SENT");
    check("T1.5. attempt.waMessageId matches", a1.waMessageId === "wamid.t1.ok");

    // ---- T2. Duplicate dispatch: second claim rejected, no double-send ----
    // Re-enqueue the same payload manually.
    graphFetchMock.fn = async () => ({ messages: [{ id: "wamid.t2.duplicate" }] });
    const payload2 = createOutboundMessageJobPayload({
      tenantId,
      wabaAccountId: wabaId,
      phoneNumberId: phoneId,
      conversationId: convId,
      messageId: m1,
      producer: "integration-test",
    });
    await prisma.outboxEvent.create({
      data: {
        tenantId,
        eventType: payload2.type,
        contractVersion: payload2.version,
        payload: payload2 as object,
        state: "PENDING",
        nextAttemptAt: new Date(),
      },
    });
    await dispatchOutboxBatch({ dispatcherId: `${runId}_dispatcher_2`, batchSize: 5, leaseMs: 5_000, queue });
    await new Promise((r) => setTimeout(r, 1_500));
    const a1AfterDup = await prisma.outboundSendAttempt.findFirst({
      where: { messageId: m1, tenantId },
      orderBy: { createdAt: "desc" },
    });
    check("T2.1. duplicate did not re-claim SENT", a1AfterDup?.state === "SENT");
    check("T2.2. waMessageId unchanged", a1AfterDup?.waMessageId === "wamid.t1.ok");

    // ---- T3. 5xx → UNCERTAIN, message PENDING ----
    graphFetchMock.fn = async () => {
      throw new WhatsAppApiError(503, "Meta 5xx");
    };
    const m3 = `${runId}_msg_5xx`;
    await createMessageAndDispatch(m3, tenantId);
    await waitForState(m3, "PENDING", 15_000);
    const a3 = await waitForAttemptState(m3, "UNCERTAIN");
    const m3Final = await prisma.message.findUnique({ where: { id: m3 } });
    check("T3.1. message PENDING on 5xx", m3Final?.status === "PENDING");
    check("T3.2. attempt UNCERTAIN on 5xx", a3.state === "UNCERTAIN");
    check("T3.3. errorJson.uncertain === true", (m3Final?.errorJson as { uncertain?: boolean } | null)?.uncertain === true);

    // ---- T4. UNCERTAIN is non-retryable: expire lease and re-claim fails ----
    await prisma.$executeRawUnsafe(
      `UPDATE "OutboundSendAttempt" SET "claimExpiresAt" = NOW() - INTERVAL '1 minute' WHERE "id" = $1`,
      a3.id
    );
    const reClaimUncertain = await prisma.$transaction(async (tx) =>
      claimOutboundAttempt(tx, { messageId: m3, tenantId, ownerId: "recovery" })
    );
    check("T4.1. UNCERTAIN cannot be re-claimed", reClaimUncertain.claimed === false);
    check("T4.2. existingState is UNCERTAIN", reClaimUncertain.existingState === "UNCERTAIN");

    // ---- T5. CLAIMED with expired lease IS re-claimable (worker crash recovery) ----
    // Create a new message, claim it, expire the claim, re-claim.
    const m5 = `${runId}_msg_crash`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Message" ("id", "tenantId", "conversationId", "direction", "type", "status", "text", "timestamp") VALUES ($1, $2, $3, 'OUT', 'TEXT', 'PENDING', 'hi', NOW())`,
      m5, tenantId, convId
    );
    await prisma.outboundSendAttempt.create({
      data: {
        messageId: m5,
        tenantId,
        state: "CLAIMED",
        claimExpiresAt: new Date(Date.now() - 60_000),
        metaRequestStartedAt: new Date(Date.now() - 120_000),
        ownerId: "crashed",
        attemptCount: 1,
      },
    });
    const reClaim = await prisma.$transaction(async (tx) =>
      claimOutboundAttempt(tx, { messageId: m5, tenantId, ownerId: "recovery" })
    );
    check("T5.1. expired CLAIMED lease is not re-claimable", reClaim.claimed === false);
    check("T5.2. attemptCount remains 1", reClaim.attempt?.attemptCount === 1);

    // ---- T5b. Slow Meta call plus duplicate job does not double-send ----
    const m7 = `${runId}_msg_slow_meta`;
    let releaseSlowMeta!: () => void;
    const slowMeta = new Promise<GraphFetchResult>((resolve) => {
      releaseSlowMeta = () => resolve({ messages: [{ id: "wamid.t5.slow" }] });
    });
    graphFetchMock.fn = async () => slowMeta;
    await createMessageAndDispatch(m7, tenantId);
    await waitForAttemptState(m7, "CLAIMED", tenantId, 15_000);
    await prisma.$executeRawUnsafe(
      `UPDATE "OutboundSendAttempt" SET "claimExpiresAt" = NOW() - INTERVAL '1 minute' WHERE "messageId" = $1`,
      m7
    );
    const payload7 = createOutboundMessageJobPayload({
      tenantId,
      wabaAccountId: wabaId,
      phoneNumberId: phoneId,
      conversationId: convId,
      messageId: m7,
      producer: "integration-test",
    });
    await queue.add(payload7.type, payload7);
    await new Promise((r) => setTimeout(r, 500));
    releaseSlowMeta();
    await waitForState(m7, "SENT");
    const callsForM7 = metaCalls.filter((req) => req.related?.id === m7).length;
    check("T5b.1. expired lease during in-flight Meta call sends once", callsForM7 === 1, `calls=${callsForM7}`);

    // ---- T6. Tenant isolation: outbox for different tenant is rejected at handler ----
    const m6 = `${runId}_msg_isolation_${Date.now()}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Message" ("id", "tenantId", "conversationId", "direction", "type", "status", "text", "timestamp") VALUES ($1, $2, $3, 'OUT', 'TEXT', 'PENDING', 'hi', NOW())`,
      m6, tenantId, convId
    );
    const payload6 = createOutboundMessageJobPayload({
      tenantId: tenantB,
      wabaAccountId: wabaId,
      phoneNumberId: phoneId,
      conversationId: convId,
      messageId: m6,
      producer: "integration-test",
    });
    graphFetchMock.fn = async () => ({ messages: [{ id: "wamid.t6" }] });
    await prisma.outboxEvent.create({
      data: {
        tenantId: tenantB,
        eventType: payload6.type,
        contractVersion: payload6.version,
        payload: payload6 as object,
        state: "PENDING",
        nextAttemptAt: new Date(),
      },
    });
    await dispatchOutboxBatch({ dispatcherId: `${runId}_dispatcher_6`, batchSize: 5, leaseMs: 5_000, queue });
    await new Promise((r) => setTimeout(r, 2_000));
    const callsForM6 = metaCalls.filter((req) => req.related?.id === m6).length;
    check("T6.1. tenant mismatch makes no Meta call", callsForM6 === 0, `calls=${callsForM6}`);
    // Attempt may exist, but handler must reject before Meta transmission.
    const m6Attempt = await prisma.outboundSendAttempt.findFirst({
      where: { messageId: m6, tenantId },
      orderBy: { createdAt: "desc" },
    });
    check("T6.2. tenant mismatch creates no send attempt", !m6Attempt);
  } catch (e) {
    console.error("FATAL", e);
    process.exit(1);
  } finally {
    try {
      if (worker) await worker.close();
    } catch { /* ignore */ }
    try {
      if (queue) await queue.close();
    } catch { /* ignore */ }
    try {
      await closeAllQueueResources();
    } catch { /* ignore */ }
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM "OutboundSendAttempt" WHERE "tenantId" LIKE $1`, `${runId}%`);
      await prisma.$executeRawUnsafe(`DELETE FROM "OutboxEvent" WHERE "tenantId" LIKE $1`, `${runId}%`);
      await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "conversationId" = $1`, convId);
      await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "id" = $1`, convId);
      await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "id" = $1`, contactId);
      await prisma.$executeRawUnsafe(`DELETE FROM "PhoneNumber" WHERE "id" = $1`, phoneId);
      await prisma.$executeRawUnsafe(`DELETE FROM "WabaAccount" WHERE "id" = $1`, wabaId);
      await prisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" LIKE $1`, `${runId}%`);
    } catch { /* ignore */ }

    // Clean Contact duplicates from previous failed runs
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "waId" = '919876543210'`);
    } catch { /* ignore */ }

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
    if (failed.length) {
      console.error(`\n${failed.length} FAILED:`);
      for (const f of failed) console.error(`  - ${f.label}${f.detail ? ` → ${f.detail}` : ""}`);
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
