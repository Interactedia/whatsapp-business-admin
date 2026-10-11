/**
 * Real PostgreSQL verification for WA-ERA2-05 transactional outbox.
 *
 * Run with:
 *   DATABASE_URL=postgresql://... npx tsx test/integration/outbox-postgres.test.ts
 */

const runId = `outbox_pg_${Date.now()}`;

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const {
    addOutboxEvent,
    claimOutboxEvents,
    getOutboxEvent,
    markOutboxPublicationFailed,
    inspectOutbox,
  } = await import("@/lib/outbox");
  const { createOutboundMessageJobPayload } = await import("@/lib/queue");

  const checks: { label: string; ok: boolean; detail?: string }[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checks.push({ label, ok, detail });
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
  };

  const tenantA = `${runId}_tenant_a`;
  const tenantB = `${runId}_tenant_b`;
  const payload = (tenantId: string, messageId: string) => createOutboundMessageJobPayload({
    tenantId,
    wabaAccountId: `${tenantId}_waba`,
    phoneNumberId: `${tenantId}_phone`,
    conversationId: `${tenantId}_conv`,
    messageId,
    producer: "integration-test",
    enqueuedAt: "2026-10-11T00:00:00.000Z",
  });

  try {
    await prisma.$executeRawUnsafe(`INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, $2, NOW()), ($3, $4, NOW())`, tenantA, tenantA, tenantB, tenantB);

    let committedId = "";
    await prisma.$transaction(async (tx) => {
      const event = await addOutboxEvent(tx, { tenantId: tenantA, payload: payload(tenantA, `${runId}_msg_commit`) });
      committedId = event.id;
    });
    check("atomic commit persists outbox event", !!(await getOutboxEvent(prisma, committedId)));

    const rolledBack = await prisma.$transaction(async (tx) => {
      const event = await addOutboxEvent(tx, { tenantId: tenantA, payload: payload(tenantA, `${runId}_msg_rollback`) });
      throw event.id;
    }).catch((id) => id as string);
    check("atomic rollback removes outbox event", (await getOutboxEvent(prisma, rolledBack)) === null);

    const [firstClaim, secondClaim] = await Promise.all([
      claimOutboxEvents(prisma, { dispatcherId: `${runId}_d1`, batchSize: 1, leaseMs: 1_000 }),
      claimOutboxEvents(prisma, { dispatcherId: `${runId}_d2`, batchSize: 1, leaseMs: 1_000 }),
    ]);
    check("concurrent claiming prevents duplicate ownership", firstClaim.length + secondClaim.length === 1, `${firstClaim.length}/${secondClaim.length}`);

    const claimed = firstClaim[0] ?? secondClaim[0];
    await prisma.$executeRaw`UPDATE "OutboxEvent" SET "claimExpiresAt" = NOW() - INTERVAL '1 second' WHERE "id" = ${claimed.id}`;
    const recovered = await claimOutboxEvents(prisma, { dispatcherId: `${runId}_recovery`, batchSize: 1, leaseMs: 1_000 });
    check("expired lease becomes recoverable", recovered[0]?.id === claimed.id);

    await markOutboxPublicationFailed(prisma, recovered[0], `${runId}_recovery`, new Error("redis://:secret@127.0.0.1:6379 failed"), { retryDelayMs: 1 });
    const failed = await getOutboxEvent(prisma, recovered[0].id);
    check("retry failure is persisted and redacted", failed?.state === "RETRYABLE" && failed.attemptCount === 1 && !failed.failureMessage?.includes("secret"));

    await addOutboxEvent(prisma, { tenantId: tenantB, payload: payload(tenantB, `${runId}_msg_tenant_b`) });
    const tenantRows = await prisma.$queryRaw<{ tenantId: string; count: bigint }[]>`
      SELECT "tenantId", COUNT(*) AS count FROM "OutboxEvent" WHERE "tenantId" IN (${tenantA}, ${tenantB}) GROUP BY "tenantId"
    `;
    check("tenant references are preserved", tenantRows.length === 2 && tenantRows.every((row) => Number(row.count) >= 1));

    const summary = await inspectOutbox(prisma);
    check("inspection reports outbox states", summary.retryable >= 1 && summary.pending >= 1);
  } finally {
    await prisma.$executeRaw`DELETE FROM "OutboxEvent" WHERE "tenantId" IN (${tenantA}, ${tenantB})`;
    await prisma.$executeRaw`DELETE FROM "Tenant" WHERE "id" IN (${tenantA}, ${tenantB})`;
    await prisma.$disconnect();
  }

  const failures = checks.filter((check) => !check.ok);
  if (failures.length) process.exit(1);
  console.log(`\n${checks.length} PostgreSQL outbox checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
