/**
 * Real PostgreSQL + Redis/BullMQ verification for WA-ERA2-13
 * Observability Failure Isolation and Read-Only Invariants.
 *
 * Run with:
 *   DATABASE_URL=postgresql://... REDIS_URL=redis://127.0.0.1:6379 \
 *   npx tsx test/integration/observability-failure-isolation.test.ts
 *
 * Verifies:
 *   - Real Redis queue metrics collection succeeds with available: true.
 *   - Real PostgreSQL outbox metrics collection succeeds with available: true.
 *   - Read-only invariant: collection causes zero database mutations or side-effects.
 *   - Redis outage isolation: queue metrics report available: false with reason (no false zeros),
 *     while database observability continues unaffected.
 *   - Database outage isolation: database metrics report available: false with error (no false zeros),
 *     while Redis queue observability continues unaffected.
 *   - UNCERTAIN outbound attempt states are reported explicitly and distinct from retryable/pending.
 */

import { randomUUID } from "node:crypto";

const runId = `obs_failure_iso_${randomUUID().slice(0, 8)}`;

async function main() {
  const originalRedisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  process.env.REDIS_URL = originalRedisUrl;
  process.env.BULLMQ_PREFIX = runId;

  const { prisma } = await import("@/lib/prisma");
  const { collectOutboxObservability } = await import("@/lib/outbox/observability");
  const { collectQueueObservability } = await import("@/lib/queue/observability");
  const { closeAllQueueResources } = await import("@/lib/queue");

  const checks: { label: string; ok: boolean; detail?: string }[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checks.push({ label, ok, detail });
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
  };

  const tenantId = `${runId}_tenant`;
  const contactId = `${runId}_contact`;
  const convId = `${runId}_conv`;
  const messageId = `${runId}_msg`;
  const attemptId = `${runId}_attempt`;

  try {
    // -------------------------------------------------------------------------
    // Setup seed data for observability assertions
    // -------------------------------------------------------------------------
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, $2, NOW())`,
      tenantId,
      tenantId
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Contact" ("id", "tenantId", "waId", "name", "createdAt", "updatedAt") VALUES ($1, $2, $3, 'Obs Contact', NOW(), NOW())`,
      contactId,
      tenantId,
      `91${Date.now() % 100000000}`
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Conversation" ("id", "tenantId", "contactId", "createdAt", "updatedAt") VALUES ($1, $2, $3, NOW(), NOW())`,
      convId,
      tenantId,
      contactId
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Message" ("id", "conversationId", "direction", "type", "status", "text", "timestamp") VALUES ($1, $2, 'OUT', 'TEXT', 'PENDING', 'obs test', NOW())`,
      messageId,
      convId
    );

    // Create an UNCERTAIN outbound attempt to verify state differentiation
    await prisma.$executeRawUnsafe(
      `INSERT INTO "OutboundSendAttempt" ("id", "tenantId", "messageId", "state", "attemptCount", "lastErrorCode", "updatedAt")
       VALUES ($1, $2, $3, 'UNCERTAIN', 1, 'AMBIGUOUS_EXTERNAL', NOW())`,
      attemptId,
      tenantId,
      messageId
    );

    // -------------------------------------------------------------------------
    // 1. Live Redis Queue Observability
    // -------------------------------------------------------------------------
    const queueReport = await collectQueueObservability();
    check("1.1. Queue observability reports available: true on healthy Redis", queueReport.available === true);
    check(
      "1.2. All 4 core queues inspected",
      queueReport.queues.length === 4 && queueReport.queues.every((q) => q.available === true),
      `count=${queueReport.queues.length}`
    );

    // -------------------------------------------------------------------------
    // 2. Live PostgreSQL Outbox Observability
    // -------------------------------------------------------------------------
    const outboxReport = await collectOutboxObservability(prisma);
    check("2.1. Outbox observability reports available: true on healthy PostgreSQL", outboxReport.available === true);
    if (outboxReport.available) {
      check(
        "2.2. Outbox report includes structured counts",
        typeof outboxReport.outbox.pending === "number" &&
          typeof outboxReport.outbox.claimed === "number" &&
          typeof outboxReport.outbox.published === "number" &&
          typeof outboxReport.outbox.retryable === "number" &&
          typeof outboxReport.outbox.terminal === "number"
      );
      const uncertainEntry = outboxReport.outboundAttempts.find((a) => a.state === "UNCERTAIN");
      check(
        "2.3. UNCERTAIN outbound attempt state reported accurately",
        Boolean(uncertainEntry && uncertainEntry.count >= 1),
        `uncertainCount=${uncertainEntry?.count}`
      );
    }

    // -------------------------------------------------------------------------
    // 3. Read-Only Invariant: No mutations during collection
    // -------------------------------------------------------------------------
    const countBefore = await prisma.outboundSendAttempt.count({ where: { id: attemptId } });
    const attemptBefore = await prisma.outboundSendAttempt.findUnique({ where: { id: attemptId } });

    // Repeated collection calls
    await collectOutboxObservability(prisma);
    await collectOutboxObservability(prisma);
    await collectQueueObservability();

    const countAfter = await prisma.outboundSendAttempt.count({ where: { id: attemptId } });
    const attemptAfter = await prisma.outboundSendAttempt.findUnique({ where: { id: attemptId } });

    check("3.1. Row count unchanged after repeated observability queries", countBefore === countAfter);
    check(
      "3.2. Record content/state untouched by observability reads",
      attemptBefore?.state === attemptAfter?.state &&
        attemptBefore?.updatedAt.toISOString() === attemptAfter?.updatedAt.toISOString()
    );

    // -------------------------------------------------------------------------
    // 4. Redis Outage Isolation: Redis failure does not zero or break DB metrics
    // -------------------------------------------------------------------------
    delete process.env.REDIS_URL;
    const redisDownReport = await collectQueueObservability();
    check(
      "4.1. Queue observability reports available: false when Redis unconfigured",
      redisDownReport.available === false
    );
    check(
      "4.2. Unconfigured Redis provides error reason instead of false 0 counts",
      redisDownReport.queues.every((q) => q.available === false && "error" in q && q.error.length > 0)
    );

    // In the same Redis-down condition, PostgreSQL outbox observability continues to work
    const outboxDuringRedisDown = await collectOutboxObservability(prisma);
    check(
      "4.3. PostgreSQL outbox metrics remain available: true during Redis outage",
      outboxDuringRedisDown.available === true
    );

    // Restore REDIS_URL
    process.env.REDIS_URL = originalRedisUrl;

    // -------------------------------------------------------------------------
    // 5. PostgreSQL Outage Isolation: DB failure does not zero or break Queue metrics
    // -------------------------------------------------------------------------
    const failingDb = {
      $queryRaw: async () => {
        throw new Error("Simulated database connection loss");
      },
    };

    const outboxDownReport = await collectOutboxObservability(failingDb as never);
    check(
      "5.1. Outbox observability reports available: false on database failure",
      outboxDownReport.available === false
    );
    if (!outboxDownReport.available) {
      check(
        "5.2. Database failure reports error name rather than false zeros",
        outboxDownReport.error === "Error",
        `error=${outboxDownReport.error}`
      );
    }

    // In the same PostgreSQL-down condition, Queue observability continues to work
    const queueDuringDbDown = await collectQueueObservability();
    check(
      "5.3. Redis queue metrics remain available: true during PostgreSQL outage",
      queueDuringDbDown.available === true
    );

    // -------------------------------------------------------------------------
    // Final check tally
    // -------------------------------------------------------------------------
    const passed = checks.filter((c) => c.ok).length;
    console.log(`\nResults: ${passed}/${checks.length} passed.`);
    if (passed !== checks.length) {
      process.exitCode = 1;
    }
  } finally {
    // Teardown test rows and close resources
    process.env.REDIS_URL = originalRedisUrl;
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM "CanonicalEventOutbox" WHERE "tenantId" = $1`, tenantId);
      await prisma.$executeRawUnsafe(
        `DELETE FROM "OutboundSendAttempt" WHERE "id" = $1`,
        attemptId
      );
      await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "id" = $1`, messageId);
      await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "id" = $1`, convId);
      await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "id" = $1`, contactId);
      await prisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId);
    } catch {
      // Ignore teardown errors
    }
    await closeAllQueueResources();
  }
}

main().catch((err) => {
  console.error("Test failed with unhandled exception:", err);
  process.exit(1);
});
