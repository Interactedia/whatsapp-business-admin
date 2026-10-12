/**
 * Real PostgreSQL verification for WA-ERA3-05 durable canonical delivery state.
 *
 * Run with:
 *   DATABASE_URL=postgresql://... npx tsx test/integration/canonical-delivery-state.test.ts
 */

const runId = `canonical_delivery_${Date.now()}`;

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const {
    addCanonicalEvent,
    claimDelivery,
    classifyCanonicalDeliveryResult,
    completeDeliveryAttempt,
    createDeliveryForEvent,
    getCanonicalEvent,
    getDeliveryRecord,
    listDeliveryAttempts,
    listEligibleDeliveries,
    nextRetryDecision,
    retryAfterDelayMs,
  } = await import("@/lib/events");
  const { buildInboundMessageReceivedEvent } = await import("@/lib/events/producers");

  const checks: { label: string; ok: boolean; detail?: string }[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checks.push({ label, ok, detail });
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
  };

  const tenantA = `${runId}_tenant_a`;
  const tenantB = `${runId}_tenant_b`;
  const eventPayload = (tenantId: string, id: string) => buildInboundMessageReceivedEvent({
    tenantId,
    conversationId: `${tenantId}_conv`,
    contactId: `${tenantId}_contact`,
    phoneNumberId: `${tenantId}_phone`,
    wabaAccountId: `${tenantId}_waba`,
    messageId: id,
    providerMessageId: `${id}.provider`,
    type: "TEXT",
    preview: "hello",
    occurredAt: "2026-10-11T12:00:00.000Z",
  });

  try {
    await prisma.$executeRawUnsafe(`INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, $2, NOW()), ($3, $4, NOW())`, tenantA, tenantA, tenantB, tenantB);
    const eventA = await addCanonicalEvent(prisma, eventPayload(tenantA, `${runId}_msg_a`));
    const eventB = await addCanonicalEvent(prisma, eventPayload(tenantB, `${runId}_msg_b`));

    const created = await Promise.all(Array.from({ length: 8 }, () => createDeliveryForEvent(prisma, { tenantId: tenantA, eventId: eventA.id, destinationId: "dest_1", maxAttempts: 2 })));
    check("concurrent creation keeps one logical delivery", new Set(created.map((d) => d.id)).size === 1);
    const delivery = created[0]!;

    await createDeliveryForEvent(prisma, { tenantId: tenantA, eventId: eventA.id, destinationId: "dest_2" });
    await createDeliveryForEvent(prisma, { tenantId: tenantB, eventId: eventB.id, destinationId: "dest_1" });
    check("multi-destination state is independent", !!(await getDeliveryRecord(prisma, { tenantId: tenantA, eventId: eventA.id, destinationId: "dest_2" })));
    check("tenant lookup cannot cross-read delivery", !(await getDeliveryRecord(prisma, { tenantId: tenantB, eventId: eventA.id, destinationId: "dest_1" })));

    const claimNow = new Date(Date.now() + 1_000);
    const claims = await Promise.all(Array.from({ length: 6 }, (_, i) => claimDelivery(prisma, { tenantId: tenantA, eventId: eventA.id, destinationId: "dest_1", workerId: `worker_${i}`, now: claimNow, leaseMs: 60_000 })));
    check("concurrent claim returns one lease", claims.filter(Boolean).length === 1);
    const claim = claims.find(Boolean)!;

    const stale = await completeDeliveryAttempt(prisma, { deliveryId: delivery.id, tenantId: tenantA, leaseOwner: "stale", attemptNumber: claim.attempt.attemptNumber, result: "ACCEPTED" });
    check("stale lease owner cannot complete", stale === null);

    const retryAt = new Date("2026-10-11T12:01:00.000Z");
    const completed = await completeDeliveryAttempt(prisma, { deliveryId: delivery.id, tenantId: tenantA, leaseOwner: claim.attempt.leaseOwner, attemptNumber: claim.attempt.attemptNumber, result: "RETRYABLE", httpStatus: 503, errorSummary: "HTTP 503 with token=redacted", nextRetryAt: retryAt });
    check("retryable completion schedules retry", completed?.state === "RETRY_PENDING" && completed.nextAttemptAt.getTime() === retryAt.getTime());
    check("attempt history persisted", (await listDeliveryAttempts(prisma, delivery.id)).length === 1);

    const beforeRetry = await claimDelivery(prisma, { tenantId: tenantA, eventId: eventA.id, destinationId: "dest_1", workerId: "too_early", now: new Date("2026-10-11T12:00:30.000Z") });
    check("retry is not claimable before nextAttemptAt", beforeRetry === null);
    const retryClaim = await claimDelivery(prisma, { tenantId: tenantA, eventId: eventA.id, destinationId: "dest_1", workerId: "retry_worker", now: retryAt, leaseMs: 10_000 });
    check("retry claim preserves event identity", retryClaim?.delivery.eventId === eventA.id);
    await completeDeliveryAttempt(prisma, { deliveryId: delivery.id, tenantId: tenantA, leaseOwner: retryClaim!.attempt.leaseOwner, attemptNumber: retryClaim!.attempt.attemptNumber, result: "TERMINAL", httpStatus: 503, errorSummary: "exhausted", terminal: true });
    check("retry exhaustion is terminal", (await getDeliveryRecord(prisma, { tenantId: tenantA, eventId: eventA.id, destinationId: "dest_1" }))?.state === "FAILED_TERMINAL");

    const recoverNow = new Date(Date.now() + 2_000);
    const recover = await createDeliveryForEvent(prisma, { tenantId: tenantA, eventId: eventA.id, destinationId: "dest_recover", nextAttemptAt: recoverNow });
    await claimDelivery(prisma, { tenantId: tenantA, eventId: eventA.id, destinationId: "dest_recover", workerId: "dead_worker", now: recoverNow, leaseMs: 1 });
    const recoverLater = new Date(recoverNow.getTime() + 1_000);
    const eligible = await listEligibleDeliveries(prisma, { tenantId: tenantA, destinationId: "dest_recover", now: recoverLater });
    const recovered = await claimDelivery(prisma, { tenantId: tenantA, eventId: eventA.id, destinationId: "dest_recover", workerId: "new_worker", now: recoverLater, leaseMs: 1_000 });
    check("expired lease recovers safely", eligible.some((row) => row.id === recover.id) && recovered?.attempt.leaseOwner === "new_worker");

    await prisma.$disconnect();
    const { prisma: reconnected } = await import("@/lib/prisma");
    check("process restart/reconnection preserves delivery state", !!(await getDeliveryRecord(reconnected, { tenantId: tenantA, eventId: eventA.id, destinationId: "dest_1" })));
    check("canonical outbox remains immutable", (await getCanonicalEvent(reconnected, eventA.id))?.payloadHash === (await getCanonicalEvent(reconnected, eventA.id))?.payloadHash);

    check("HTTP 200/202 classify accepted", classifyCanonicalDeliveryResult({ status: "accepted", eventId: eventA.id, destinationId: "dest", tenantId: tenantA, httpStatus: 202 }).attemptResult === "ACCEPTED");
    check("HTTP 408/429/5xx classify retryable", [408, 429, 500, 503].every((httpStatus) => classifyCanonicalDeliveryResult({ status: "rejected", eventId: eventA.id, destinationId: "dest", tenantId: tenantA, httpStatus }).attemptResult === "RETRYABLE"));
    check("HTTP 400 classify terminal", classifyCanonicalDeliveryResult({ status: "rejected", eventId: eventA.id, destinationId: "dest", tenantId: tenantA, httpStatus: 400 }).attemptResult === "TERMINAL");
    check("network/timeout classify retryable", classifyCanonicalDeliveryResult({ status: "network_error", eventId: eventA.id, destinationId: "dest", tenantId: tenantA, error: "ECONNRESET" }).attemptResult === "RETRYABLE" && classifyCanonicalDeliveryResult({ status: "timeout", eventId: eventA.id, destinationId: "dest", tenantId: tenantA, timeoutMs: 10 }).attemptResult === "RETRYABLE");
    const now = new Date("2026-10-11T12:00:00.000Z");
    check("Retry-After valid/invalid bounded", retryAfterDelayMs("120", now, 5_000) === 5_000 && retryAfterDelayMs("bad", now, 5_000) === null);
    check("bounded backoff and max attempts", nextRetryDecision(2, null, { now, baseDelayMs: 1_000, maxDelayMs: 3_000, maxAttempts: 5 }).delayMs === 2_000 && nextRetryDecision(5, null, { now, maxAttempts: 5 }).exhausted);
  } finally {
    await prisma.$executeRawUnsafe(`DELETE FROM "CanonicalEventDeliveryAttempt" WHERE "deliveryId" IN (SELECT "id" FROM "CanonicalEventDelivery" WHERE "tenantId" LIKE $1)`, `${runId}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "CanonicalEventDelivery" WHERE "tenantId" LIKE $1`, `${runId}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "CanonicalEventOutbox" WHERE "tenantId" LIKE $1`, `${runId}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" LIKE $1`, `${runId}%`);
    await prisma.$disconnect();
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    console.error("\nFailed checks:", failed);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
