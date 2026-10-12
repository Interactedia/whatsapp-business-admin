/**
 * Real PostgreSQL verification for WA-ERA3-03 durable canonical event outbox.
 *
 * Run with:
 *   DATABASE_URL=postgresql://... npx tsx test/integration/canonical-event-outbox.test.ts
 */

const runId = `canonical_outbox_${Date.now()}`;

async function main() {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const { prisma } = await import("@/lib/prisma");
  const {
    CanonicalEventOutboxConflictError,
    addCanonicalEvent,
    getCanonicalEvent,
    listCanonicalEvents,
  } = await import("@/lib/events");
  const {
    buildConversationStatusChangedEvent,
    buildInboundMessageReceivedEvent,
    buildOutboundMessageStatusChangedEvent,
  } = await import("@/lib/events/producers");

  const checks: { label: string; ok: boolean; detail?: string }[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checks.push({ label, ok, detail });
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
  };

  const tenantA = `${runId}_tenant_a`;
  const tenantB = `${runId}_tenant_b`;
  const event = (tenantId: string, messageId: string) => buildInboundMessageReceivedEvent({
    tenantId,
    conversationId: `${tenantId}_conv`,
    contactId: `${tenantId}_contact`,
    phoneNumberId: `${tenantId}_phone`,
    wabaAccountId: `${tenantId}_waba`,
    messageId,
    providerMessageId: `${messageId}.provider`,
    type: "TEXT",
    preview: "hello",
    occurredAt: "2026-10-11T12:00:00.000Z",
  });

  try {
    await prisma.$executeRawUnsafe(`INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, $2, NOW()), ($3, $4, NOW())`, tenantA, tenantA, tenantB, tenantB);

    const committed = event(tenantA, `${runId}_msg_commit`);
    await prisma.$transaction(async (tx) => {
      await addCanonicalEvent(tx, committed);
    });
    check("atomic commit persists canonical event", !!(await getCanonicalEvent(prisma, tenantA, committed.id)));

    const rolledBack = event(tenantA, `${runId}_msg_rollback`);
    await prisma.$transaction(async (tx) => {
      await addCanonicalEvent(tx, rolledBack);
      throw new Error("rollback sentinel");
    }).catch(() => undefined);
    check("rolled-back transaction leaves no event", !(await getCanonicalEvent(prisma, tenantA, rolledBack.id)));

    const duplicate = event(tenantA, `${runId}_msg_dup`);
    const [first, second] = await Promise.all([
      addCanonicalEvent(prisma, duplicate),
      addCanonicalEvent(prisma, duplicate),
    ]);
    check("concurrent identical duplicate inserts are idempotent", first.id === duplicate.id && second.id === duplicate.id);
    const dupRows = await prisma.canonicalEventOutbox.findMany({ where: { id: duplicate.id } });
    check("PostgreSQL primary key prevents duplicate rows", dupRows.length === 1, `rows=${dupRows.length}`);

    const conflicting = buildInboundMessageReceivedEvent({
      tenantId: tenantA,
      conversationId: `${tenantA}_conv`,
      contactId: `${tenantA}_contact`,
      phoneNumberId: `${tenantA}_phone`,
      wabaAccountId: `${tenantA}_waba`,
      messageId: `${runId}_msg_dup`,
      providerMessageId: `${runId}_msg_dup.provider`,
      type: "TEXT",
      preview: "different",
      occurredAt: "2026-10-11T12:00:00.000Z",
    });
    let conflictRejected = false;
    try {
      await addCanonicalEvent(prisma, conflicting);
    } catch (error) {
      conflictRejected = error instanceof CanonicalEventOutboxConflictError;
    }
    check("conflicting duplicate event IDs are rejected", conflictRejected);

    check("tenant-scoped get blocks cross-tenant reads", !(await getCanonicalEvent(prisma, tenantB, committed.id)));
    check("bounded tenant list excludes other tenants", (await listCanonicalEvents(prisma, { tenantId: tenantB, limit: 10 })).length === 0);

    const outboundNoop = buildOutboundMessageStatusChangedEvent({
      tenantId: tenantA,
      conversationId: `${tenantA}_conv`,
      messageId: `${tenantA}_out_msg`,
      phoneNumberId: `${tenantA}_phone`,
      wabaAccountId: `${tenantA}_waba`,
      previousStatus: "SENT",
      status: "SENT",
      occurredAt: "2026-10-11T12:01:00.000Z",
    });
    check("outbound no-op status transition creates no event", outboundNoop === null);

    const conversationNoop = await prisma.$transaction(async (tx) => {
      const convEvent = buildConversationStatusChangedEvent({
        tenantId: tenantA,
        conversationId: `${tenantA}_conv_noop`,
        contactId: `${tenantA}_contact`,
        phoneNumberId: `${tenantA}_phone`,
        wabaAccountId: `${tenantA}_waba`,
        previousStatus: "OPEN",
        status: "OPEN",
        occurredAt: "2026-10-11T12:02:00.000Z",
      });
      if (convEvent) await addCanonicalEvent(tx, convEvent);
      return convEvent;
    });
    check("conversation no-op creates no event", conversationNoop === null);

    const txFailEvent = event(tenantA, `${runId}_msg_state_rollback`);
    await prisma.$transaction(async (tx) => {
      await tx.contact.create({ data: { id: `${runId}_rollback_contact`, tenantId: tenantA, waId: `${runId}_wa` } });
      await addCanonicalEvent(tx, txFailEvent);
      await addCanonicalEvent(tx, { ...txFailEvent, payload: { ...txFailEvent.payload, preview: "conflict" } });
    }).catch(() => undefined);
    check("event insertion failure rolls back business state", !(await prisma.contact.findUnique({ where: { id: `${runId}_rollback_contact` } })));
    check("event insertion failure leaves no partial event", !(await getCanonicalEvent(prisma, tenantA, txFailEvent.id)));

    const durable = event(tenantA, `${runId}_msg_durable`);
    await addCanonicalEvent(prisma, durable);
    await prisma.$disconnect();
    const fresh = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    try {
      check("committed event survives reconnection", !!(await getCanonicalEvent(fresh, tenantA, durable.id)));
    } finally {
      await fresh.$disconnect();
    }

    const failed = checks.filter((c) => !c.ok);
    if (failed.length) throw new Error(`Failed checks: ${failed.map((c) => c.label).join(", ")}`);
  } finally {
    await prisma.$connect().catch(() => undefined);
    await prisma.canonicalEventOutbox.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } }).catch(() => undefined);
    await prisma.contact.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } }).catch(() => undefined);
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } }).catch(() => undefined);
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
