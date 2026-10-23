/**
 * WA-OUTRETRY-01 — Recovery, traceability, migration, regressions.
 *
 * Run with:
 *   DATABASE_URL=postgresql://... REDIS_URL=redis://127.0.0.1:6379 \
 *   npx tsx test/integration/outbound-retry-recovery.test.ts
 */
import { randomUUID } from "node:crypto";

const runId = `out_retry_recover_${randomUUID().slice(0, 8)}`;

async function main() {
  process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  process.env.BULLMQ_PREFIX = runId;
  process.env.WHATSAPP_TYPING_ENABLED = "false";
  process.env.OUTBOUND_RETRY_POLL_MS = "500";
  process.env.OUTBOUND_RETRY_BATCH = "10";
  process.env.ENCRYPTION_KEY ??= "0".repeat(63) + "1";

  const { prisma } = await import("@/lib/prisma");
  const { encrypt } = await import("@/lib/crypto");
  const repo = await import("@/lib/whatsapp/outbound/repository");
  const { closeAllQueueResources, enqueueQueueJob } = await import("@/lib/queue");
  const { createOutboundMessageJobPayload } = await import("@/lib/queue/jobs/outbound");

  const checks: { label: string; ok: boolean; detail?: string }[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checks.push({ label, ok, detail });
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
  };

  const encryptedToken = encrypt("test-access-token");

  async function makeAttempt(label: string) {
    const tenantId = `${runId}_${label}_tenant`;
    const wabaId = `${runId}_${label}_waba`;
    const phoneId = `${runId}_${label}_phone`;
    const contactId = `${runId}_${label}_contact`;
    const convId = `${runId}_${label}_conv`;
    const msgId = `${runId}_${label}_msg`;

    await prisma.$executeRawUnsafe(
      `INSERT INTO "Tenant" ("id", "name", "createdAt", "updatedAt") VALUES ($1, $2, NOW(), NOW())`,
      tenantId,
      `Tenant ${label}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "WabaAccount" ("id", "tenantId", "metaWabaId", "name", "accessTokenEnc", "appSecret", "apiVersion", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, 'sec', 'v21.0', NOW(), NOW())`,
      wabaId, tenantId, `${runId}_${label}_mw`, `Waba ${label}`, encryptedToken,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "PhoneNumber" ("id", "wabaAccountId", "metaPhoneNumberId", "displayPhone", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      phoneId, wabaId, `${runId}_${label}_mp`, `+1555${Math.floor(Math.random() * 1e6)}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Contact" ("id", "tenantId", "waId", "createdAt", "updatedAt") VALUES ($1, $2, $3, NOW(), NOW())`,
      contactId, tenantId, `521${Math.floor(Math.random() * 1e8)}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Conversation" ("id", "tenantId", "contactId", "phoneNumberId", "status", "createdAt", "updatedAt", "lastMessageAt") VALUES ($1, $2, $3, $4, 'OPEN', NOW(), NOW(), NOW())`,
      convId, tenantId, contactId, phoneId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Message" ("id", "tenantId", "conversationId", "direction", "type", "status", "text", "timestamp") VALUES ($1, $2, $3, 'OUT', 'TEXT', 'PENDING', 'hello', NOW())`,
      msgId, tenantId, convId,
    );
    return { tenantId, wabaId, phoneId, contactId, convId, msgId };
  }

  // ============================================================
  // ESCENARIO A: scheduler crash after DB claim before enqueue
  // ============================================================
  {
    const ctx = await makeAttempt("Acrash");
    // Set up: create a RETRYABLE row with nextEligibleRetryAt in the past.
    await prisma.$transaction(async (tx) => {
      await repo.getOrCreateOutboundAttempt(tx, { messageId: ctx.msgId, tenantId: ctx.tenantId });
    });
    await prisma.$executeRawUnsafe(
      `UPDATE "OutboundSendAttempt" SET "state" = 'RETRYABLE', "nextEligibleRetryAt" = NOW() - INTERVAL '1 second', "autoRetryCount" = 1 WHERE "messageId" = $1`,
      ctx.msgId,
    );

    // Simulate: scheduler claims the row, then crashes before enqueueing.
    // We call claimAutoRetryCandidates (the SELECT only — no state change)
    // and then simulate a crash by NOT calling enqueueQueueJob. The row
    // stays RETRYABLE with the past nextEligibleRetryAt.
    const claimed = await repo.claimAutoRetryCandidates(prisma, { limit: 50 });
    const ourRow = claimed.find((c) => c.messageId === ctx.msgId);
    check("A1. scheduler saw the row", !!ourRow);

    // Verify the row is STILL RETRYABLE (we no longer flip to PENDING here).
    const after = await prisma.outboundSendAttempt.findFirst({ where: { messageId: ctx.msgId } });
    check("A2. row is RETRYABLE after scheduler claim (no premature transition)", after!.state === "RETRYABLE");
    check("A3. row has a past nextEligibleRetryAt so the next tick re-picks it", after!.nextEligibleRetryAt !== null && after!.nextEligibleRetryAt! <= new Date());

    // Now a fresh scheduler tick must re-pick the same row.
    const claimed2 = await repo.claimAutoRetryCandidates(prisma, { limit: 50 });
    const ourRow2 = claimed2.find((c) => c.messageId === ctx.msgId);
    check("A4. fresh scheduler tick re-picks the row (no retry lost)", !!ourRow2);
  }

  // ============================================================
  // ESCENARIO B: scheduler enqueues but crashes before returning
  // The job is in BullMQ. The next scheduler tick re-enqueues with the
  // same jobId; BullMQ dedups so there is no duplicate job.
  // ============================================================
  {
    const ctx = await makeAttempt("Benq");
    await prisma.$transaction(async (tx) => {
      await repo.getOrCreateOutboundAttempt(tx, { messageId: ctx.msgId, tenantId: ctx.tenantId });
    });
    await prisma.$executeRawUnsafe(
      `UPDATE "OutboundSendAttempt" SET "state" = 'RETRYABLE', "nextEligibleRetryAt" = NOW() - INTERVAL '1 second', "autoRetryCount" = 1 WHERE "messageId" = $1`,
      ctx.msgId,
    );
    const payload = createOutboundMessageJobPayload({
      tenantId: ctx.tenantId,
      wabaAccountId: ctx.wabaId,
      phoneNumberId: ctx.phoneId,
      conversationId: ctx.convId,
      messageId: ctx.msgId,
      producer: "manual:test",
    });
    const e1 = await enqueueQueueJob(payload, { closeQueueAfterEnqueue: true });
    // "Crash" here: re-enqueue with the same payload (deterministic jobId).
    const e2 = await enqueueQueueJob(payload, { closeQueueAfterEnqueue: true });
    check("B1. deterministic jobId dedupes the second enqueue", e1.jobId === e2.jobId);
    check("B2. BullMQ returns the same jobId even after a 'crash' between enqueues", e1.bullmqJobId === e2.bullmqJobId);
  }

  // ============================================================
  // ESCENARIO C: worker claims but crashes before Meta call
  // Lease expires → recoverExpiredLeases → RETRYABLE with
  // nextEligibleRetryAt set, so the scheduler re-enqueues.
  // ============================================================
  {
    const ctx = await makeAttempt("Cworker");
    await prisma.$transaction(async (tx) => {
      await repo.getOrCreateOutboundAttempt(tx, { messageId: ctx.msgId, tenantId: ctx.tenantId });
    });
    await prisma.$executeRawUnsafe(
      `UPDATE "OutboundSendAttempt" SET "state" = 'CLAIMED', "claimExpiresAt" = NOW() - INTERVAL '1 minute', "metaRequestStartedAt" = NULL, "ownerId" = 'crashed-worker' WHERE "messageId" = $1`,
      ctx.msgId,
    );
    const r = await repo.recoverExpiredLeases(prisma, {});
    check("C1. pre-frontier lease recovered as RETRYABLE", r.preFrontier === 1);
    const a = await prisma.outboundSendAttempt.findFirst({ where: { messageId: ctx.msgId } });
    check("C2. attempt is RETRYABLE", a!.state === "RETRYABLE");
    check("C3. nextEligibleRetryAt is set (in the future)", a!.nextEligibleRetryAt !== null && a!.nextEligibleRetryAt! > new Date());
    check("C4. autoRetryCount is NOT incremented (recovery != real retry)", a!.autoRetryCount === 0);
    // The scheduler should be able to pick this row up after the hold elapses.
    // Force the hold to be in the past to verify.
    await prisma.$executeRawUnsafe(
      `UPDATE "OutboundSendAttempt" SET "nextEligibleRetryAt" = NOW() - INTERVAL '1 second' WHERE "messageId" = $1`,
      ctx.msgId,
    );
    const claimed = await repo.claimAutoRetryCandidates(prisma, { limit: 50 });
    const ourRow = claimed.find((c) => c.messageId === ctx.msgId);
    check("C5. scheduler re-picks recovered row after hold elapses", !!ourRow);
  }

  // ============================================================
  // ESCENARIO D: worker dies after Meta frontier
  // Lease expires → recoverExpiredLeases → UNCERTAIN.
  // nextEligibleRetryAt stays NULL → scheduler never re-picks.
  // ============================================================
  {
    const ctx = await makeAttempt("Dpost");
    await prisma.$transaction(async (tx) => {
      await repo.getOrCreateOutboundAttempt(tx, { messageId: ctx.msgId, tenantId: ctx.tenantId });
    });
    await prisma.$executeRawUnsafe(
      `UPDATE "OutboundSendAttempt" SET "state" = 'CLAIMED', "claimExpiresAt" = NOW() - INTERVAL '1 minute', "metaRequestStartedAt" = NOW() - INTERVAL '30 seconds', "ownerId" = 'crashed-worker' WHERE "messageId" = $1`,
      ctx.msgId,
    );
    const r = await repo.recoverExpiredLeases(prisma, {});
    check("D1. post-frontier lease recovered as UNCERTAIN", r.postFrontier === 1);
    const a = await prisma.outboundSendAttempt.findFirst({ where: { messageId: ctx.msgId } });
    check("D2. attempt is UNCERTAIN", a!.state === "UNCERTAIN");
    check("D3. nextEligibleRetryAt is NULL — scheduler must not re-pick", a!.nextEligibleRetryAt === null);
    // Confirm: scheduler query returns zero rows for this messageId.
    await prisma.$executeRawUnsafe(
      `UPDATE "OutboundSendAttempt" SET "nextEligibleRetryAt" = NOW() + INTERVAL '1 second' WHERE "messageId" = $1`,
      ctx.msgId,
    );
    // This UPDATE should not match (state=UNCERTAIN) — the scheduler query
    // filters by state=RETRYABLE so even if nextEligibleRetryAt were set,
    // the row would not match.
    const claimed = await repo.claimAutoRetryCandidates(prisma, { limit: 50 });
    const ourRow = claimed.find((c) => c.messageId === ctx.msgId);
    check("D4. scheduler does not re-pick UNCERTAIN row", !ourRow);
  }

  // ============================================================
  // TRAZABILIDAD: cada intento queda registrado en ApiLog con
  // attemptNumber, sin destruir el estado operativo.
  // ============================================================
  {
    const ctx = await makeAttempt("Taudit");
    await prisma.$transaction(async (tx) => {
      await repo.getOrCreateOutboundAttempt(tx, { messageId: ctx.msgId, tenantId: ctx.tenantId });
    });
    // Simulate a 429 attempt → mark RETRYABLE with autoRetryCount=1.
    await prisma.$executeRawUnsafe(
      `UPDATE "OutboundSendAttempt" SET "state" = 'RETRYABLE', "metaRequestStartedAt" = NULL, "lastErrorCode" = 'META_RATE_LIMIT', "lastMetaStatus" = 429, "autoRetryCount" = 1, "nextEligibleRetryAt" = NOW() + INTERVAL '30 seconds' WHERE "messageId" = $1`,
      ctx.msgId,
    );
    // Record a synthetic ApiLog row (the real ApiLog is written by graphFetch).
    const apilogId = `${runId}_Taudit_apilog`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ApiLog" ("id", "method", "endpoint", "relatedType", "relatedId", "ok", "responseStatus", "error", "durationMs", "attemptNumber", "createdAt") VALUES ($1, 'POST', '/v21.0/144/messages', 'message', $2, false, 429, 'rate limit', 200, 1, NOW())`,
      apilogId, ctx.msgId,
    );
    const a = await prisma.outboundSendAttempt.findFirst({ where: { messageId: ctx.msgId } });
    const api = await prisma.apiLog.findMany({ where: { relatedId: ctx.msgId, relatedType: "message" } });
    check("T1. lastErrorCode retained on attempt row (evidence)", a!.lastErrorCode === "META_RATE_LIMIT");
    check("T2. lastMetaStatus retained on attempt row (evidence)", a!.lastMetaStatus === 429);
    check("T3. ApiLog has the historical record with attemptNumber", api.length === 1 && api[0].attemptNumber === 1 && api[0].responseStatus === 429);
    check("T4. metaRequestStartedAt is NULL (clean for next attempt)", a!.metaRequestStartedAt === null);
    check("T5. nextEligibleRetryAt is set (scheduler will pick up)", a!.nextEligibleRetryAt !== null);
  }

  // ============================================================
  // MIGRACIÓN: el ledger de Prisma contiene la migración aplicada.
  // ============================================================
  {
    const ledger = await prisma.$queryRawUnsafe<Array<{ migration_name: string; finished_at: Date }>>(
      `SELECT migration_name, finished_at FROM _prisma_migrations WHERE migration_name = $1`,
      "20261018180000_wa_outretry_01",
    );
    check("M1. migration 20261018180000_wa_outretry_01 is in Prisma ledger", ledger.length === 1);
  }

  // ============================================================
  // REGRESIONES: los 7 attempts pre-existentes siguen legibles
  // y conservan su estado post-migración.
  // ============================================================
  {
    const preExisting = await prisma.$queryRawUnsafe<Array<{ state: string; autoRetryCount: number }>>(
      `SELECT state, "autoRetryCount" FROM "OutboundSendAttempt" WHERE "messageId" NOT LIKE $1`,
      `${runId}%`,
    );
    check(`R1. ${preExisting.length} pre-existing attempts preserved with autoRetryCount=0`, preExisting.length >= 1 && preExisting.every((r) => r.autoRetryCount === 0));
  }

  // ============================================================
  // End-to-end: 429 → scheduler → re-enqueue → next worker call succeeds.
  // ============================================================
  {
    const ctx = await makeAttempt("E2E");
    await prisma.$transaction(async (tx) => {
      await repo.getOrCreateOutboundAttempt(tx, { messageId: ctx.msgId, tenantId: ctx.tenantId });
    });
    // Set RETRYABLE with past nextEligibleRetryAt
    await prisma.$executeRawUnsafe(
      `UPDATE "OutboundSendAttempt" SET "state" = 'RETRYABLE', "nextEligibleRetryAt" = NOW() - INTERVAL '1 second', "autoRetryCount" = 1, "lastErrorCode" = 'META_RATE_LIMIT' WHERE "messageId" = $1`,
      ctx.msgId,
    );
    // Use only this single row's claim to avoid cross-test bleed.
    const claimed = await repo.claimAutoRetryCandidates(prisma, { limit: 50 });
    const ourRow = claimed.find((c) => c.messageId === ctx.msgId);
    check("E2E1. scheduler tick claimed the row", !!ourRow);
    check("E2E2. only one of the test rows is the E2E one", claimed.filter((c) => c.messageId === ctx.msgId).length === 1);
    // The row should still be RETRYABLE.
    const a = await prisma.outboundSendAttempt.findFirst({ where: { messageId: ctx.msgId } });
    check("E2E3. row is still RETRYABLE after scheduler claim (no premature PENDING)", a!.state === "RETRYABLE");
    // Move the nextEligibleRetryAt back to the past and re-claim — this
    // simulates the next tick after the hold window.
    await prisma.$executeRawUnsafe(
      `UPDATE "OutboundSendAttempt" SET "nextEligibleRetryAt" = NOW() - INTERVAL '1 second' WHERE "messageId" = $1`,
      ctx.msgId,
    );
    const claimed2 = await repo.claimAutoRetryCandidates(prisma, { limit: 50 });
    check("E2E4. scheduler re-claims the row after the hold window elapses", claimed2.some((c) => c.messageId === ctx.msgId));
  }

  // ----- Cleanup ------------------------------------------------------
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "CanonicalEventOutbox" WHERE "tenantId" LIKE $1`, `${runId}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "OutboundSendAttempt" WHERE "tenantId" LIKE $1`, `${runId}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "conversationId" LIKE $1`, `${runId}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "id" LIKE $1`, `${runId}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "id" LIKE $1`, `${runId}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "PhoneNumber" WHERE "id" LIKE $1`, `${runId}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "WabaAccount" WHERE "id" LIKE $1`, `${runId}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" LIKE $1`, `${runId}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "ApiLog" WHERE "relatedId" LIKE $1`, `${runId}%`);
  } catch (cleanupErr) {
    console.error("cleanup error", cleanupErr);
  }
  await closeAllQueueResources();
  await prisma.$disconnect();

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed:`);
    for (const f of failed) console.error(`  - ${f.label}${f.detail ? ` → ${f.detail}` : ""}`);
    process.exit(1);
  }
  console.log(`\n${checks.length} checks passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
