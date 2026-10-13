/**
 * WA-ERA5-02 — Real PostgreSQL integration for inbound webhook remediation.
 *
 * Covers the acceptance gates that cannot be proven with mocks:
 *   - a valid Meta inbound payload persists Contact + Conversation + Message
 *   - a REJECTED payload persists ZERO business records (the observed defect:
 *     Contact created, Conversation absent, Message absent)
 *   - duplicate delivery produces no duplicate Message
 *   - two independent WABA configurations route to their own tenants
 *   - no cross-tenant routing
 *   - WebhookEvent diagnostics are persisted without credential material
 *
 * Run with:
 *   DATABASE_URL=postgresql://... ENCRYPTION_KEY=... npx tsx test/integration/inbound-remediation.test.ts
 *
 * No external WhatsApp calls are made: only text inbound payloads, which never
 * trigger media download.
 */

const runId = `inbound_remediation_${Date.now()}`;

/** Realistic base64-shaped Meta wamid (the charset the old pattern rejected). */
const REAL_WAMID = (suffix: string) =>
  `wamid.HBgN${runId.slice(-8)}${suffix}EXAMPLEBODY+xyz/ABC==`;

async function main() {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "0".repeat(64);

  const { prisma } = await import("@/lib/prisma");
  const { processWebhook } = await import("@/lib/whatsapp/webhook");

  const checks: { label: string; ok: boolean; detail?: string }[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checks.push({ label, ok, detail });
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
  };

  // Tenant A owns WABA A / Phone A. Tenant B owns WABA B / Phone B.
  const tenantA = `${runId}_tA`;
  const tenantB = `${runId}_tB`;
  const wabaA = `${runId}_wabaA`;
  const wabaB = `${runId}_wabaB`;
  const phoneA = `${runId}_phoneA`;
  const phoneB = `${runId}_phoneB`;
  const metaPhoneA = `${runId}_metaA`;
  const metaPhoneB = `${runId}_metaB`;
  const contactWa = `${Date.now()}5550101`;

  const payload = (metaPhone: string, messageId: string, body = "hello") => ({
    object: "whatsapp_business_account",
    entry: [{
      id: `${runId}_meta_waba`,
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "+10000000000", phone_number_id: metaPhone },
          contacts: [{ wa_id: contactWa, profile: { name: "Remediation Test" } }],
          messages: [{
            from: contactWa,
            id: messageId,
            timestamp: "1800000000",
            type: "text",
            text: { body },
          }],
        },
      }],
    }],
  });

  const businessRecords = async () => ({
    contacts: await prisma.contact.count({ where: { waId: contactWa } }),
    conversations: await prisma.conversation.count({ where: { tenantId: { in: [tenantA, tenantB] } } }),
    messages: await prisma.message.count({ where: { tenantId: { in: [tenantA, tenantB] } } }),
  });

  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, $2, NOW()), ($3, $4, NOW())`,
      tenantA, tenantA, tenantB, tenantB,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "WabaAccount" ("id", "tenantId", "metaWabaId", "updatedAt") VALUES ($1, $2, $3, NOW()), ($4, $5, $6, NOW())`,
      wabaA, tenantA, `${runId}_meta_wabaA`, wabaB, tenantB, `${runId}_meta_wabaB`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "PhoneNumber" ("id", "wabaAccountId", "metaPhoneNumberId", "displayPhone", "updatedAt") VALUES ($1, $2, $3, $4, NOW()), ($5, $6, $7, $8, NOW())`,
      phoneA, wabaA, metaPhoneA, "+10000000001", phoneB, wabaB, metaPhoneB, "+10000000002",
    );

    // ---- Gate: a REJECTED payload creates ZERO business records ----
    // This is the exact defect observed against real Meta traffic: the wamid
    // charset was rejected while building the canonical event, rolling back
    // Conversation and Message but leaving the Contact orphaned.
    const before = await businessRecords();
    let rejectedError: unknown = null;
    try {
      await processWebhook(payload(metaPhoneA, "wamid.malformed with space"));
    } catch (error) {
      rejectedError = error;
    }
    const afterReject = await businessRecords();
    check("malformed provider id is rejected", rejectedError !== null, String(rejectedError));
    check(
      "rejected payload creates no Contact",
      afterReject.contacts === before.contacts,
      `before=${before.contacts} after=${afterReject.contacts}`,
    );
    check(
      "rejected payload creates no Conversation",
      afterReject.conversations === before.conversations,
      `before=${before.conversations} after=${afterReject.conversations}`,
    );
    check(
      "rejected payload creates no Message",
      afterReject.messages === before.messages,
      `before=${before.messages} after=${afterReject.messages}`,
    );

    // ---- Gate: a VALID payload persists Contact + Conversation + Message ----
    const validWamid = REAL_WAMID("A");
    const summary = await processWebhook(payload(metaPhoneA, validWamid, "real meta message"));
    check("valid Meta wamid is accepted", summary === `message from ${contactWa}`, summary);

    const contact = await prisma.contact.findFirst({ where: { tenantId: tenantA, waId: contactWa } });
    check("valid payload creates the expected Contact", !!contact && contact.tenantId === tenantA);

    const conversation = await prisma.conversation.findFirst({
      where: { tenantId: tenantA, phoneNumberId: phoneA },
    });
    check(
      "valid payload creates the expected Conversation bound to Phone A",
      !!conversation && conversation.contactId === contact?.id,
      conversation ? `contactId=${conversation.contactId}` : "missing",
    );

    const message = await prisma.message.findUnique({ where: { waMessageId: validWamid } });
    check("valid payload creates the expected Message", !!message && message.tenantId === tenantA);
    check("message is inbound and received", message?.direction === "IN" && message?.status === "RECEIVED");
    check("message carries the provider id verbatim", message?.waMessageId === validWamid);

    // ---- Gate: duplicate delivery produces no duplicate Message ----
    const dupSummary = await processWebhook(payload(metaPhoneA, validWamid, "real meta message"));
    check("duplicate delivery is reported as a duplicate", dupSummary.includes("dup"), dupSummary);
    check(
      "duplicate delivery creates no duplicate Message",
      (await prisma.message.count({ where: { waMessageId: validWamid } })) === 1,
    );
    check(
      "duplicate delivery creates no duplicate Conversation",
      (await prisma.conversation.count({ where: { tenantId: tenantA, phoneNumberId: phoneA } })) === 1,
    );
    check(
      "duplicate delivery does not double-count unread",
      (await prisma.conversation.findFirst({ where: { tenantId: tenantA, phoneNumberId: phoneA } }))?.unreadCount === 1,
    );

    // ---- Gate: concurrent duplicate deliveries stay idempotent ----
    const raceWamid = REAL_WAMID("R");
    await Promise.allSettled([
      processWebhook(payload(metaPhoneA, raceWamid, "race")),
      processWebhook(payload(metaPhoneA, raceWamid, "race")),
    ]);
    check(
      "concurrent duplicate deliveries persist exactly one Message",
      (await prisma.message.count({ where: { waMessageId: raceWamid } })) === 1,
    );

    // ---- Gate: two independent WABA configurations route to their tenants ----
    const wamidB = REAL_WAMID("B");
    const summaryB = await processWebhook(payload(metaPhoneB, wamidB, "tenant b message"));
    check("WABA B payload is accepted", summaryB === `message from ${contactWa}`, summaryB);

    const messageB = await prisma.message.findUnique({ where: { waMessageId: wamidB } });
    check("WABA B routes to Tenant B", messageB?.tenantId === tenantB, String(messageB?.tenantId));
    check(
      "WABA B conversation is bound to Phone B",
      (await prisma.conversation.findUnique({ where: { id: messageB?.conversationId ?? "" } }))?.phoneNumberId === phoneB,
    );

    // ---- Gate: no cross-tenant leakage ----
    check("Tenant A has no Tenant B messages",
      (await prisma.message.count({ where: { waMessageId: wamidB, tenantId: tenantA } })) === 0);
    check("Tenant B has no Tenant A messages",
      (await prisma.message.count({ where: { waMessageId: validWamid, tenantId: tenantB } })) === 0);
    check(
      "same sender wa_id is isolated per tenant (distinct Contact rows)",
      (await prisma.contact.count({ where: { waId: contactWa, tenantId: { in: [tenantA, tenantB] } } })) === 2,
    );

    // ---- Gate: an unknown phone cannot be routed to any tenant ----
    let unresolved: unknown = null;
    try {
      await processWebhook(payload(`${runId}_unknown_phone`, REAL_WAMID("U"), "orphan"));
    } catch (error) {
      unresolved = error;
    }
    check("unresolvable phone number is rejected", unresolved !== null, String(unresolved));
    check(
      "unresolvable phone creates no Message",
      (await prisma.message.count({ where: { waMessageId: REAL_WAMID("U") } })) === 0,
    );

    // ---- Gate: diagnostics persist structured detail without secrets ----
    const { formatWebhookError, processingErrorDiagnostic } = await import("@/lib/whatsapp/inbound/diagnostics");
    const diagnosticError = new Error("graph call failed with accessToken=EAAG_SUPER_SECRET_TOKEN_VALUE");
    const persisted = formatWebhookError(processingErrorDiagnostic("inbound.processing", diagnosticError, "evt_corr_1"));
    const parsed = JSON.parse(persisted) as Record<string, string>;

    check("diagnostic records the failed stage", parsed.stage === "inbound.processing", persisted);
    check("diagnostic records an error category", !!parsed.category, persisted);
    check("diagnostic records the correlation id", parsed.correlationId === "evt_corr_1", persisted);
    check("diagnostic never stores the access token", !persisted.includes("EAAG_SUPER_SECRET_TOKEN_VALUE"), persisted);
    check("diagnostic stays bounded", persisted.length <= 1024, `len=${persisted.length}`);

    const { authRejectionDiagnostic } = await import("@/lib/whatsapp/inbound/diagnostics");
    const authPersisted = formatWebhookError(authRejectionDiagnostic("SIGNATURE_INVALID", "evt_corr_2"));
    check(
      "authentication rejection diagnostic names the header, not its value",
      authPersisted.includes("x-hub-signature-256") && !authPersisted.includes("sha256="),
      authPersisted,
    );
  } finally {
    for (const tenantId of [tenantA, tenantB]) {
      await prisma.canonicalEventOutbox.deleteMany({ where: { tenantId } });
      await prisma.message.deleteMany({ where: { tenantId } });
      await prisma.conversation.deleteMany({ where: { tenantId } });
      await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    }
    await prisma.contact.deleteMany({ where: { waId: contactWa } });
    await prisma.phoneNumber.deleteMany({ where: { id: { in: [phoneA, phoneB] } } });
    await prisma.wabaAccount.deleteMany({ where: { id: { in: [wabaA, wabaB] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prisma.$disconnect();
  }

  const failed = checks.filter((result) => !result.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    console.error(failed);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
