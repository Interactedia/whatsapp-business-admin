/**
 * Real PostgreSQL verification for WA-ERA3-06 tenant webhook destinations.
 *
 * Run with:
 *   DATABASE_URL=postgresql://... ENCRYPTION_KEY=<64 hex chars> npx tsx test/integration/webhook-destinations-postgres.test.ts
 */

import crypto from "node:crypto";
import http from "node:http";

const runId = `webhook_dest_${Date.now()}`;
process.env.ENCRYPTION_KEY ??= "0".repeat(64);

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const {
    createWebhookDestination,
    getWebhookDestination,
    listWebhookDestinations,
    listWebhookDeliveryHistory,
    retireWebhookDestination,
    rotateWebhookDestinationSecret,
    setWebhookDestinationEnabled,
    updateWebhookDestination,
    webhookDestinationInputSchema,
  } = await import("@/lib/events/webhook-destinations");
  const { signWebhookBody, verifyWebhookSignature } = await import("@/lib/events/webhook-signing");
  const { deliverCanonicalEventHttp } = await import("@/lib/events/delivery");
  const { listEligibleDeliveries } = await import("@/lib/events/delivery-state");
  const { EXTERNAL_EVENT_TYPES } = await import("@/lib/events/contract");

  const checks: { label: string; ok: boolean; detail?: string }[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checks.push({ label, ok, detail });
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
  };

  const tenantA = `${runId}_tenant_a`;
  const tenantB = `${runId}_tenant_b`;
  const eventId = `${runId}_event`;
  let destinationId = "";

  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, $2, NOW()), ($3, $4, NOW())`,
      tenantA,
      tenantA,
      tenantB,
      tenantB,
    );

    const created = await createWebhookDestination(tenantA, {
      name: "ops-hook",
      endpointUrl: "https://hooks.example.test/wa",
      subscriptions: [EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED],
    });
    destinationId = created.destination.id;
    check("create destination for tenant A", created.destination.tenantId === tenantA && Boolean(created.signingSecret), destinationId);

    const stored = await prisma.webhookDestination.findUniqueOrThrow({ where: { id: destinationId } });
    check("tenant ownership persisted", stored.tenantId === tenantA);
    check("secret ciphertext storage", stored.signingSecretEnc !== created.signingSecret && /^[A-Za-z0-9+/]+=*$/.test(stored.signingSecretEnc));
    check("public retrieval excludes secrets", !("signingSecretEnc" in created.destination) && !("signingSecret" in created.destination));

    const fetchedA = await getWebhookDestination(tenantA, destinationId);
    check("retrieve destination for tenant A", fetchedA?.id === destinationId);
    const fetchedB = await getWebhookDestination(tenantB, destinationId);
    check("reject retrieval from tenant B", fetchedB === null);

    const updated = await updateWebhookDestination(tenantA, destinationId, {
      name: "ops-hook-renamed",
      endpointUrl: "https://hooks.example.test/wa-v2",
      subscriptions: [EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED],
    });
    check("update destination preserving stable ID", updated?.id === destinationId && updated.endpointUrl.endsWith("/wa-v2"));

    const crossTenantUpdate = await updateWebhookDestination(tenantB, destinationId, { name: "bad" });
    check("reject cross-tenant update", crossTenantUpdate === null);

    const disabled = await setWebhookDestinationEnabled(tenantA, destinationId, false);
    check("disable destination", disabled?.enabled === false);
    const listedDisabled = await listWebhookDestinations(tenantA);
    check("disabled destination is ineligible", !listedDisabled.some((row) => row.id === destinationId && row.enabled && row.retiredAt === null));

    const rotated = await rotateWebhookDestinationSecret(tenantA, destinationId);
    const afterRotate = await prisma.webhookDestination.findUniqueOrThrow({ where: { id: destinationId } });
    check("rotate encrypted signing secret", rotated?.destination.secretVersion === 2 && rotated.signingSecret !== created.signingSecret);
    check("rotated secret persisted as ciphertext", afterRotate.signingSecretEnc !== stored.signingSecretEnc && afterRotate.signingSecretEnc !== rotated?.signingSecret);

    const signed = signWebhookBody("{}", rotated!.signingSecret);
    check("HMAC signing verifies after rotation", verifyWebhookSignature("{}", rotated!.signingSecret, signed.timestamp, signed.signature));

    check("HTTPS enforcement", !webhookDestinationInputSchema.safeParse({
      name: "bad",
      endpointUrl: "http://hooks.example.test/wa",
      subscriptions: [EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED],
    }).success);
    const canonicalEvent = {
      id: eventId,
      type: EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED,
      version: 1,
      tenantId: tenantA,
      occurredAt: new Date().toISOString(),
      recordedAt: new Date().toISOString(),
      entities: [{ kind: "conversation" as const, id: `${runId}_conversation` }],
      meta: { producer: "integration" },
      payload: {
        conversationId: `${runId}_conversation`,
        contactId: `${runId}_contact`,
        phoneNumberId: null,
        wabaAccountId: null,
        kind: "STATUS_CHANGED" as const,
        status: "OPEN" as const,
        occurredAt: new Date().toISOString(),
      },
    };
    const ssrfResult = await deliverCanonicalEventHttp(
      { id: destinationId, tenantId: tenantA, url: "https://127.0.0.1/wa", signingSecret: rotated!.signingSecret },
      canonicalEvent,
    );
    check("SSRF localhost protection", ssrfResult.status === "invalid_destination");
    const redirectServer = await new Promise<import("node:http").Server>((resolve) => {
      const server = http.createServer((_request, response) => {
        response.writeHead(302, { location: "http://127.0.0.1/next" });
        response.end();
      });
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
    try {
      const address = redirectServer.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const redirectResult = await deliverCanonicalEventHttp(
        { id: destinationId, tenantId: tenantA, url: `http://127.0.0.1:${port}/redirect`, signingSecret: rotated!.signingSecret },
        canonicalEvent,
        { allowLoopbackForTests: true },
      );
      check("redirect rejection", redirectResult.status === "invalid_destination");
    } finally {
      await new Promise<void>((resolve, reject) => redirectServer.close((error) => error ? reject(error) : resolve()));
    }

    await prisma.canonicalEventOutbox.create({
      data: {
        id: eventId,
        tenantId: tenantA,
        eventType: EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED,
        contractVersion: 1,
        payload: { id: eventId, tenantId: tenantA, type: EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED },
        payloadHash: crypto.createHash("sha256").update(eventId).digest("hex"),
        occurredAt: new Date(),
        recordedAt: new Date(),
      },
    });
    const delivery = await prisma.canonicalEventDelivery.create({
      data: { tenantId: tenantA, eventId, destinationId, state: "PENDING", attemptCount: 1 },
    });
    const attempt = await prisma.canonicalEventDeliveryAttempt.create({
      data: { deliveryId: delivery.id, leaseOwner: "integration", attemptNumber: 1, startedAt: new Date(), completedAt: new Date(), httpStatus: 202, result: "ACCEPTED" },
    });

    await setWebhookDestinationEnabled(tenantA, destinationId, true);
    const eligibleBeforeRetire = await listEligibleDeliveries(prisma, { tenantId: tenantA, destinationId, now: new Date(), limit: 20 });
    check("persistent destination ID compatible with delivery", eligibleBeforeRetire.some((row) => row.id === delivery.id && row.destinationId === destinationId));

    const retired = await retireWebhookDestination(tenantA, destinationId);
    check("retire destination softly", retired?.retiredAt !== null && retired?.enabled === false);
    const deliveryAfterRetire = await prisma.canonicalEventDelivery.findUnique({ where: { id: delivery.id } });
    const attemptAfterRetire = await prisma.canonicalEventDeliveryAttempt.findUnique({ where: { id: attempt.id } });
    check("preserve CanonicalEventDelivery references", deliveryAfterRetire?.destinationId === destinationId);
    check("preserve CanonicalEventDeliveryAttempt records", attemptAfterRetire?.deliveryId === delivery.id);
    const history = await listWebhookDeliveryHistory(tenantA, destinationId);
    check("historical delivery visible after retirement", history?.some((row) => row.id === delivery.id) === true);
    const eligibleAfterRetire = await listWebhookDestinations(tenantA);
    check("retired destination cannot be selected for dispatch", !eligibleAfterRetire.some((row) => row.id === destinationId && row.enabled && row.retiredAt === null));

    console.log(`\nPostgreSQL integration checks executed: ${checks.length}`);
    const failed = checks.filter((row) => !row.ok);
    if (failed.length) throw new Error(`${failed.length} PostgreSQL integration checks failed`);
  } finally {
    await prisma.$executeRawUnsafe(`DELETE FROM "CanonicalEventDeliveryAttempt" WHERE "deliveryId" IN (SELECT "id" FROM "CanonicalEventDelivery" WHERE "tenantId" IN ($1, $2))`, tenantA, tenantB).catch(() => undefined);
    await prisma.$executeRawUnsafe(`DELETE FROM "CanonicalEventDelivery" WHERE "tenantId" IN ($1, $2)`, tenantA, tenantB).catch(() => undefined);
    await prisma.$executeRawUnsafe(`DELETE FROM "CanonicalEventOutbox" WHERE "tenantId" IN ($1, $2)`, tenantA, tenantB).catch(() => undefined);
    await prisma.$executeRawUnsafe(`DELETE FROM "WebhookDestination" WHERE "tenantId" IN ($1, $2)`, tenantA, tenantB).catch(() => undefined);
    await prisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" IN ($1, $2)`, tenantA, tenantB).catch(() => undefined);
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
