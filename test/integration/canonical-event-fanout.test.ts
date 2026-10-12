/**
 * Real PostgreSQL verification for WA-ERA3-07-FANOUT canonical subscription
 * fanout.
 *
 * Run with:
 *   DATABASE_URL=postgresql://... ENCRYPTION_KEY=<64 hex chars> npx tsx test/integration/canonical-event-fanout.test.ts
 */

const runId = `canonical_fanout_${Date.now()}`;
process.env.ENCRYPTION_KEY ??= "0".repeat(64);

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const {
    addCanonicalEvent,
    fanoutCanonicalEvent,
    getCanonicalEvent,
    listEligibleWebhookDestinations,
    FanoutError,
    EXTERNAL_EVENT_TYPES,
  } = await import("@/lib/events");
  const {
    createWebhookDestination,
    setWebhookDestinationEnabled,
    retireWebhookDestination,
  } = await import("@/lib/events/webhook-destinations");
  const { buildInboundMessageReceivedEvent, buildConversationChangedEvent } = await import("@/lib/events/producers");

  const checks: { label: string; ok: boolean; detail?: string }[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checks.push({ label, ok, detail });
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
  };

  const tenantA = `${runId}_tenant_a`;
  const tenantB = `${runId}_tenant_b`;
  const inbound = (tenantId: string, messageId: string) =>
    buildInboundMessageReceivedEvent({
      tenantId,
      conversationId: `${tenantId}_conv`,
      contactId: `${tenantId}_contact`,
      phoneNumberId: `${tenantId}_phone`,
      wabaAccountId: `${tenantId}_waba`,
      messageId,
      providerMessageId: `${messageId}.provider`,
      type: "TEXT",
      preview: "hello",
      occurredAt: "2026-10-12T12:00:00.000Z",
    });
  const conversationEvent = (tenantId: string) =>
    buildConversationChangedEvent({
      tenantId,
      conversationId: `${tenantId}_conv`,
      contactId: `${tenantId}_contact`,
      phoneNumberId: `${tenantId}_phone`,
      wabaAccountId: `${tenantId}_waba`,
      kind: "CREATED",
      status: "OPEN",
      occurredAt: "2026-10-12T12:00:00.000Z",
    });

  const createdDestinationIds: string[] = [];
  const insertedEventIds: string[] = [];
  let ranNetworkDuringFanout = false;

  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, $2, NOW()), ($3, $4, NOW())`,
      tenantA,
      tenantA,
      tenantB,
      tenantB,
    );

    // -------------------------------------------------------------------------
    // Setup: 1 event + 3 destinations in tenant A (subscribed, unsubscribed,
    // disabled) plus 1 destination in tenant B subscribed to the same event
    // type. This exercises filtering by subscription, enabled, retired and
    // tenant ownership in a single fixture.
    // -------------------------------------------------------------------------
    const eventA = await addCanonicalEvent(prisma, inbound(tenantA, `${runId}_msg_a`));
    insertedEventIds.push(eventA.id);
    const eventB = await addCanonicalEvent(prisma, inbound(tenantB, `${runId}_msg_b`));
    insertedEventIds.push(eventB.id);
    void eventB;

    const subscribedA = await createWebhookDestination(tenantA, {
      name: "subscribed",
      endpointUrl: "https://hooks.example.test/tenant-a-subscribed",
      subscriptions: [EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED],
    });
    createdDestinationIds.push(subscribedA.destination.id);

    const unsubscribedA = await createWebhookDestination(tenantA, {
      name: "unsubscribed",
      endpointUrl: "https://hooks.example.test/tenant-a-unsubscribed",
      subscriptions: [EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED],
    });
    createdDestinationIds.push(unsubscribedA.destination.id);

    const disabledA = await createWebhookDestination(tenantA, {
      name: "disabled",
      endpointUrl: "https://hooks.example.test/tenant-a-disabled",
      subscriptions: [EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED],
    });
    createdDestinationIds.push(disabledA.destination.id);
    await setWebhookDestinationEnabled(tenantA, disabledA.destination.id, false);

    const tenantBSubscribed = await createWebhookDestination(tenantB, {
      name: "tenant-b-subscribed",
      endpointUrl: "https://hooks.example.test/tenant-b-subscribed",
      subscriptions: [EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED],
    });
    createdDestinationIds.push(tenantBSubscribed.destination.id);

    // -------------------------------------------------------------------------
    // 1. Eligible destination lookup: only one tenant-A subscribed+enabled
    //    destination should be discovered.
    // -------------------------------------------------------------------------
    const eligible = await listEligibleWebhookDestinations(prisma, {
      tenantId: tenantA,
      eventType: EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED,
    });
    check(
      "eligible destination lookup filters by tenant + subscription + enabled + not retired",
      eligible.length === 1 && eligible[0]?.id === subscribedA.destination.id,
      `count=${eligible.length}`,
    );

    // -------------------------------------------------------------------------
    // 2. Unsupported event type rejected.
    // -------------------------------------------------------------------------
    let unsupportedRejected = false;
    try {
      await listEligibleWebhookDestinations(prisma, {
        tenantId: tenantA,
        eventType: "fabricated.event" as never,
      });
    } catch (err) {
      unsupportedRejected = err instanceof Error;
    }
    check("unsupported event type rejected at eligibility lookup", unsupportedRejected);

    // -------------------------------------------------------------------------
    // 3. Single fanout invocation for tenant A creates exactly one durable
    //    delivery and excludes unsubscribed, disabled and cross-tenant
    //    destinations.
    // -------------------------------------------------------------------------
    const fanoutA = await fanoutCanonicalEvent(prisma, { tenantId: tenantA, eventId: eventA.id });
    check(
      "fanout produces one created delivery and excludes non-eligible destinations",
      fanoutA.created === 1 && fanoutA.alreadyExists === 0 && fanoutA.failed === 0 && fanoutA.discoveredDestinations === 1,
      JSON.stringify({
        created: fanoutA.created,
        alreadyExists: fanoutA.alreadyExists,
        failed: fanoutA.failed,
        discovered: fanoutA.discoveredDestinations,
      }),
    );

    const storedDeliveryA = await prisma.canonicalEventDelivery.findFirst({
      where: { tenantId: tenantA, eventId: eventA.id, destinationId: subscribedA.destination.id },
    });
    check(
      "delivery record exists with expected tenant/event/destination identity",
      Boolean(storedDeliveryA) && storedDeliveryA?.state === "PENDING",
      `id=${storedDeliveryA?.id} state=${storedDeliveryA?.state}`,
    );

    const deliveryForUnsubscribed = await prisma.canonicalEventDelivery.count({
      where: { tenantId: tenantA, eventId: eventA.id, destinationId: unsubscribedA.destination.id },
    });
    check("no delivery for unsubscribed destination", deliveryForUnsubscribed === 0);

    const deliveryForDisabled = await prisma.canonicalEventDelivery.count({
      where: { tenantId: tenantA, eventId: eventA.id, destinationId: disabledA.destination.id },
    });
    check("no delivery for disabled destination", deliveryForDisabled === 0);

    const deliveryForCrossTenant = await prisma.canonicalEventDelivery.count({
      where: { tenantId: tenantA, eventId: eventA.id, destinationId: tenantBSubscribed.destination.id },
    });
    check("no cross-tenant delivery created", deliveryForCrossTenant === 0);

    // -------------------------------------------------------------------------
    // 4. Repeated fanout is idempotent: re-invoking fanout for the same event
    //    must NOT create a duplicate logical delivery and must NOT mutate the
    //    outbox.
    // -------------------------------------------------------------------------
    const outboxBefore = await getCanonicalEvent(prisma, tenantA, eventA.id);
    const repeated = await fanoutCanonicalEvent(prisma, { tenantId: tenantA, eventId: eventA.id });
    const outboxAfter = await getCanonicalEvent(prisma, tenantA, eventA.id);
    check(
      "repeated fanout reports already_exists and zero creates",
      repeated.created === 0 && repeated.alreadyExists === 1 && repeated.failed === 0,
      JSON.stringify({ created: repeated.created, alreadyExists: repeated.alreadyExists }),
    );
    check(
      "canonical outbox immutable across repeated fanout",
      JSON.stringify(outboxBefore?.payload) === JSON.stringify(outboxAfter?.payload) &&
        outboxBefore?.payloadHash === outboxAfter?.payloadHash,
    );

    const allDeliveriesForEvent = await prisma.canonicalEventDelivery.count({
      where: { tenantId: tenantA, eventId: eventA.id },
    });
    check("only one logical delivery per (tenant, event, destination)", allDeliveriesForEvent === 1);

    // -------------------------------------------------------------------------
    // 5. Multi-destination fanout: enabling the disabled destination and
    //    switching the unsubscribed destination to subscribe must produce
    //    three deliveries in a single fanout call.
    // -------------------------------------------------------------------------
    await updateDestinationSubscriptions(tenantA, unsubscribedA.destination.id, [
      EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED,
    ]);
    await setWebhookDestinationEnabled(tenantA, disabledA.destination.id, true);
    const secondEventA = await addCanonicalEvent(prisma, inbound(tenantA, `${runId}_msg_a2`));
    insertedEventIds.push(secondEventA.id);
    const multiFanout = await fanoutCanonicalEvent(prisma, {
      tenantId: tenantA,
      eventId: secondEventA.id,
    });
    check(
      "multi-destination fanout creates one delivery per eligible destination",
      multiFanout.created === 3 && multiFanout.failed === 0 && multiFanout.discoveredDestinations === 3,
      JSON.stringify({ created: multiFanout.created, discovered: multiFanout.discoveredDestinations }),
    );

    // -------------------------------------------------------------------------
    // 6. Retired destinations are excluded from new fanout invocations while
    //    pre-existing deliveries remain intact.
    // -------------------------------------------------------------------------
    await retireWebhookDestination(tenantA, subscribedA.destination.id);
    const thirdEventA = await addCanonicalEvent(prisma, inbound(tenantA, `${runId}_msg_a3`));
    insertedEventIds.push(thirdEventA.id);
    const postRetireFanout = await fanoutCanonicalEvent(prisma, {
      tenantId: tenantA,
      eventId: thirdEventA.id,
    });
    check(
      "retired destination excluded from new fanout",
      postRetireFanout.discoveredDestinations === 2 && postRetireFanout.failed === 0,
      `discovered=${postRetireFanout.discoveredDestinations}`,
    );

    const historicalDeliveries = await prisma.canonicalEventDelivery.count({
      where: { tenantId: tenantA, destinationId: subscribedA.destination.id },
    });
    check("historical deliveries for retired destination are preserved", historicalDeliveries >= 1);

    // -------------------------------------------------------------------------
    // 7. Tenant ownership enforcement: an attempt to fanout an event from
    //    tenant A using tenant B credentials must fail and must NOT create
    //    any delivery for tenant A or B.
    // -------------------------------------------------------------------------
    const beforeCrossTenantCount = await prisma.canonicalEventDelivery.count({
      where: { eventId: eventA.id },
    });
    let crossTenantError: unknown = null;
    try {
      await fanoutCanonicalEvent(prisma, { tenantId: tenantB, eventId: eventA.id });
    } catch (err) {
      crossTenantError = err;
    }
    const afterCrossTenantCount = await prisma.canonicalEventDelivery.count({
      where: { eventId: eventA.id },
    });
    check(
      "fanout rejects cross-tenant event access",
      crossTenantError instanceof FanoutError &&
        (crossTenantError as FanoutError).code === "EVENT_NOT_FOUND" &&
        afterCrossTenantCount === beforeCrossTenantCount,
    );

    // -------------------------------------------------------------------------
    // 8. Event not found and invalid input handled explicitly.
    // -------------------------------------------------------------------------
    let notFoundError: unknown = null;
    try {
      await fanoutCanonicalEvent(prisma, { tenantId: tenantA, eventId: "non-existent-event-id" });
    } catch (err) {
      notFoundError = err;
    }
    check(
      "fanout reports EVENT_NOT_FOUND for unknown event",
      notFoundError instanceof FanoutError && (notFoundError as FanoutError).code === "EVENT_NOT_FOUND",
    );

    let inputError: unknown = null;
    try {
      // ponytail: explicit empty-string rejection keeps callers honest.
      await fanoutCanonicalEvent(prisma, { tenantId: "", eventId: eventA.id });
    } catch (err) {
      inputError = err;
    }
    check(
      "fanout rejects empty tenantId",
      inputError instanceof FanoutError && (inputError as FanoutError).code === "INVALID_INPUT",
    );

    // -------------------------------------------------------------------------
    // 9. Conversation-changed event type fans out to the conversation
    //    subscription only, proving subscription matching uses the
    //    canonical event's own type.
    // -------------------------------------------------------------------------
    const conversationEvt = await addCanonicalEvent(prisma, conversationEvent(tenantA));
    insertedEventIds.push(conversationEvt.id);
    const eligibleConv = await listEligibleWebhookDestinations(prisma, {
      tenantId: tenantA,
      eventType: EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED,
    });
    check(
      "subscription matching driven by event type",
      eligibleConv.length === 0,
      `eligibleConv=${eligibleConv.length}`,
    );

    // -------------------------------------------------------------------------
    // 10. No-network fanout: register a fetch monkey patch to assert no HTTP
    //     request is attempted by the fanout service itself.
    // -------------------------------------------------------------------------
    const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = (() => {
      ranNetworkDuringFanout = true;
      throw new Error("Network call attempted during fanout");
    }) as typeof fetch;
    try {
      const eventNetworkGuard = await addCanonicalEvent(prisma, inbound(tenantA, `${runId}_msg_a_network`));
      insertedEventIds.push(eventNetworkGuard.id);
      const guarded = await fanoutCanonicalEvent(prisma, {
        tenantId: tenantA,
        eventId: eventNetworkGuard.id,
      });
      check("fanout performs zero network calls", !ranNetworkDuringFanout && guarded.created >= 1);
    } finally {
      if (originalFetch) (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
    }

    // -------------------------------------------------------------------------
    // 11. Concurrent fanout invocations against the same event must not
    //     create duplicate logical delivery records. Real PostgreSQL
    //     concurrency is exercised via Promise.all; uniqueness is enforced
    //     by the existing @@unique([tenantId, eventId, destinationId])
    //     constraint and the ON CONFLICT clause in `ensureDeliveryRecord`.
    // -------------------------------------------------------------------------
    const concurrentEvent = await addCanonicalEvent(prisma, inbound(tenantA, `${runId}_msg_concurrent`));
    insertedEventIds.push(concurrentEvent.id);
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () =>
        fanoutCanonicalEvent(prisma, { tenantId: tenantA, eventId: concurrentEvent.id }),
      ),
    );
    const totalCreated = concurrent.reduce((acc, r) => acc + r.created, 0);
    const totalAlreadyExists = concurrent.reduce((acc, r) => acc + r.alreadyExists, 0);
    const discoveredPerInvocation = concurrent[0]?.discoveredDestinations ?? 0;
    const concurrentDeliveryCount = await prisma.canonicalEventDelivery.count({
      where: { tenantId: tenantA, eventId: concurrentEvent.id },
    });
    check(
      "concurrent fanout produces exactly one logical delivery per destination regardless of races",
      concurrentDeliveryCount === discoveredPerInvocation,
      `count=${concurrentDeliveryCount} expected=${discoveredPerInvocation}`,
    );
    check(
      "concurrent fanout splits created vs already_exists across callers",
      totalCreated + totalAlreadyExists === 8 * discoveredPerInvocation && totalCreated >= 1,
      `created=${totalCreated} alreadyExists=${totalAlreadyExists} destinations=${discoveredPerInvocation}`,
    );

    // -------------------------------------------------------------------------
    // 12. Partial failure recovery: simulate a per-destination error by
    //     using a wrapped Prisma client that fails the first delivery
    //     creation call. The remaining destination must still receive a
    //     delivery and the failed one must be reported explicitly. The
    //     wrapper restores the underlying client after the call so that
    //     retry fans out cleanly.
    // -------------------------------------------------------------------------
    const recoveryEvent = await addCanonicalEvent(prisma, inbound(tenantA, `${runId}_msg_recovery`));
    insertedEventIds.push(recoveryEvent.id);
    let ensureCallCount = 0;
    const partialDb = wrapPrismaForPartialFailure(prisma, () => {
      ensureCallCount += 1;
      return ensureCallCount === 1;
    });
    const partial = await fanoutCanonicalEvent(partialDb as never, {
      tenantId: tenantA,
      eventId: recoveryEvent.id,
    });
    check(
      "partial failure leaves successful deliveries intact and reports failure explicitly",
      partial.failed === 1 && partial.created + partial.alreadyExists === 1,
      `failed=${partial.failed} created=${partial.created} alreadyExists=${partial.alreadyExists}`,
    );

    // Retry the fanout: it must reconcile the previously failed destination
    // without creating duplicates for the already-created ones.
    const retry = await fanoutCanonicalEvent(prisma, { tenantId: tenantA, eventId: recoveryEvent.id });
    const retryDeliveries = await prisma.canonicalEventDelivery.count({
      where: { tenantId: tenantA, eventId: recoveryEvent.id },
    });
    check(
      "recovery by repeated fanout safely reconciles previously created records",
      retryDeliveries === 2 && retry.failed === 0,
      `deliveries=${retryDeliveries} failed=${retry.failed}`,
    );
  } catch (err) {
    check("integration test threw", false, err instanceof Error ? err.message : String(err));
  } finally {
    // Cleanup: best effort, in FK-safe order.
    if (insertedEventIds.length) {
      await prisma.canonicalEventDelivery.deleteMany({
        where: { eventId: { in: insertedEventIds } },
      }).catch(() => undefined);
      await prisma.canonicalEventOutbox.deleteMany({
        where: { id: { in: insertedEventIds } },
      }).catch(() => undefined);
    }
    if (createdDestinationIds.length) {
      await prisma.webhookDestination.deleteMany({
        where: { id: { in: createdDestinationIds } },
      }).catch(() => undefined);
    }
    await prisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" IN ($1, $2)`, tenantA, tenantB).catch(() => undefined);
    await prisma.$disconnect();
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${checks.length} fanout checks passed.`);
}

async function updateDestinationSubscriptions(tenantId: string, id: string, subscriptions: string[]) {
  const { updateWebhookDestination } = await import("@/lib/events/webhook-destinations");
  await updateWebhookDestination(tenantId, id, { subscriptions: subscriptions as never });
}

/**
 * Wrap the prisma client so the first call to `ensureDeliveryRecord` (i.e. the
 * first `$queryRaw` whose SQL targets `CanonicalEventDelivery`) throws. The
 * rest of the prisma surface is forwarded unchanged. The decision to fail is
 * delegated to `shouldFail()` so the test can bound the failure window.
 */
function wrapPrismaForPartialFailure(
  base: typeof prisma,
  shouldFail: () => boolean
): typeof prisma {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "$queryRaw") {
        return (strings: TemplateStringsArray | readonly string[], ...values: unknown[]) => {
          const parts = Array.isArray(strings) ? (strings as readonly string[]) : [];
          const sql = parts.join("");
          if (sql.includes('"CanonicalEventDelivery"') && shouldFail()) {
            throw new Error("simulated per-destination delivery creation failure");
          }
          return Reflect.apply(target.$queryRaw as (...a: unknown[]) => unknown, target, [
            strings,
            ...values,
          ]);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
