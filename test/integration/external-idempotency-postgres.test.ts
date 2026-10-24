/**
 * Real PostgreSQL verification for WA-REMEDIATION-1A — External Outbound Idempotency.
 *
 * The production POST /api/v1/messages handler runs against the real database;
 * only the Meta Graph HTTP boundary is stubbed so provider transmissions can be
 * counted. No production messages are sent.
 *
 * Run with:
 *   DATABASE_URL=postgresql://... ENCRYPTION_KEY=<64 hex> \
 *   npx tsx test/integration/external-idempotency-postgres.test.ts
 *
 * Verifies:
 *   - first keyed request creates exactly one message (201 sync / 202 async);
 *   - equivalent duplicate returns the original identity (200), no new message,
 *     no queue event and no provider transmission;
 *   - conflicting duplicate payload → 409 and no send;
 *   - changed recipient/content with the same key → 409;
 *   - a different tenant using the same key stays isolated;
 *   - concurrent identical requests create exactly one message / one Meta call;
 *   - the key binding is durable in PostgreSQL (independent client re-read);
 *   - unauthenticated duplicate is rejected with 401 (no send);
 *   - requests without a key keep their legacy 201 behavior;
 *   - the tenant-scoped unique index exists and is enforced.
 */

const runId = `idem_${Date.now()}`;

type Check = { label: string; ok: boolean; detail?: string };
const checks: Check[] = [];
function check(label: string, ok: boolean, detail?: string) {
  checks.push({ label, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
}

async function main() {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "0".repeat(64);
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wa:wa@localhost:5434/wa_admin?schema=public";
  delete process.env.WHATSAPP_OUTBOUND_ASYNC_ENABLED;

  const { prisma } = await import("@/lib/prisma");
  const { encrypt } = await import("@/lib/crypto");
  const { generateKey } = await import("@/lib/api-keys");
  const { POST } = await import("@/app/api/v1/messages/route");

  // ---- Meta Graph boundary stub: count provider transmissions ----
  let metaCalls = 0;
  let metaFailuresRemaining = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const url = typeof input === "string" ? input : ((input as { url?: string })?.url ?? "");
    if (url.includes("graph.facebook.com")) {
      metaCalls += 1;
      if (metaFailuresRemaining > 0) {
        metaFailuresRemaining -= 1;
        return {
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ error: { message: "simulated graph outage", code: 500 } }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ messages: [{ id: `wamid.${runId}.${metaCalls}` }] }),
      } as unknown as Response;
    }
    return realFetch(input as never, init as never);
  }) as typeof fetch;

  async function post(opts: { key?: string | null; apiKey?: string | null; body: unknown }) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
    if (opts.key) headers["idempotency-key"] = opts.key;
    const request = new Request("http://localhost/api/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body),
    });
    const res = await POST(request, { params: Promise.resolve({}) });
    let json: Record<string, unknown> | null = null;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      /* no body */
    }
    return { status: res.status, json };
  }

  const recipientA = "919000000001";
  const recipientA2 = "919000000003";
  const recipientB = "919000000002";

  async function seed(label: string, recipient: string) {
    const tenantId = `${runId}_t_${label}`;
    const wabaId = `${runId}_waba_${label}`;
    const phoneId = `${runId}_phone_${label}`;
    const key = generateKey();
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId } });
    await prisma.wabaAccount.create({
      data: { id: wabaId, tenantId, metaWabaId: `${runId}_meta_${label}`, name: tenantId, accessTokenEnc: encrypt("test-token") },
    });
    await prisma.phoneNumber.create({
      data: { id: phoneId, wabaAccountId: wabaId, metaPhoneNumberId: `${runId}_pn_${label}`, displayPhone: "+10000000000", verifiedName: tenantId },
    });
    await prisma.apiKey.create({
      data: { id: `${runId}_key_${label}`, name: tenantId, keyHash: key.keyHash, keyPrefix: key.keyPrefix, tenantId },
    });
    const contact = await prisma.contact.create({ data: { tenantId, waId: recipient, name: label } });
    const conversation = await prisma.conversation.create({
      data: { tenantId, contactId: contact.id, phoneNumberId: phoneId, lastInboundAt: new Date() },
    });
    return { tenantId, apiKey: key.plaintext, phoneId, conversationId: conversation.id, contactId: contact.id };
  }

  const countKey = (tenantId: string, key: string) =>
    prisma.message.count({ where: { tenantId, idempotencyKey: key } });
  const countOutbox = (tenantId: string) => prisma.outboxEvent.count({ where: { tenantId } });

  let A: Awaited<ReturnType<typeof seed>> | null = null;
  let B: Awaited<ReturnType<typeof seed>> | null = null;

  try {
    A = await seed("A", recipientA);
    B = await seed("B", recipientB);

    // ---- 1. First keyed request (sync) ----
    const r1 = await post({ key: "K1", apiKey: A.apiKey, body: { to: recipientA, type: "text", text: "Hello" } });
    check("first keyed request is accepted with 201", r1.status === 201, `status=${r1.status}`);
    check("first keyed request returns message identity", Boolean(r1.json?.id) && Boolean(r1.json?.message_id), `id=${r1.json?.id}`);
    check("first keyed request performs exactly one provider transmission", metaCalls === 1, `metaCalls=${metaCalls}`);
    check("first keyed request creates exactly one logical message", (await countKey(A.tenantId, "K1")) === 1);

    // ---- 2. Equivalent duplicate ----
    const r2 = await post({ key: "K1", apiKey: A.apiKey, body: { to: recipientA, type: "text", text: "Hello" } });
    check("equivalent duplicate returns 200", r2.status === 200, `status=${r2.status}`);
    check("equivalent duplicate is flagged and reuses the original identity",
      r2.json?.duplicate === true && r2.json?.id === r1.json?.id && r2.json?.message_id === r1.json?.message_id);
    check("equivalent duplicate creates no extra provider transmission", metaCalls === 1, `metaCalls=${metaCalls}`);
    check("equivalent duplicate creates no extra message", (await countKey(A.tenantId, "K1")) === 1);

    // ---- 2b. Legacy `to` then equivalent conversationId ----
    const crossKey = `cross-${runId}`;
    const crossFirst = await post({ key: crossKey, apiKey: A.apiKey, body: { to: recipientA, type: "text", text: "Canonical" } });
    const crossCalls = metaCalls;
    const crossDuplicate = await post({ key: crossKey, apiKey: A.apiKey, body: { conversationId: A.conversationId, type: "text", text: "Canonical" } });
    check("legacy `to` then equivalent conversationId returns duplicate",
      crossFirst.status === 201 && crossDuplicate.status === 200 && crossDuplicate.json?.duplicate === true,
      `status=${crossFirst.status}/${crossDuplicate.status}`);
    check("canonical duplicate reuses one message and one Meta call",
      crossDuplicate.json?.id === crossFirst.json?.id && (await countKey(A.tenantId, crossKey)) === 1 && metaCalls === crossCalls,
      `metaCalls=${metaCalls}`);
    const metaAfterCanonicalChecks = metaCalls;

    // ---- 2c. Same key through a different business phone route ----
    const alternateWabaId = `${runId}_waba_alt`;
    const alternatePhoneId = `${runId}_phone_alt`;
    await prisma.wabaAccount.create({ data: { id: alternateWabaId, tenantId: A.tenantId, metaWabaId: `${runId}_meta_alt`, accessTokenEnc: encrypt("test-token") } });
    await prisma.phoneNumber.create({ data: { id: alternatePhoneId, wabaAccountId: alternateWabaId, metaPhoneNumberId: `${runId}_pn_alt` } });
    const alternateConversation = await prisma.conversation.create({
      data: { tenantId: A.tenantId, contactId: A.contactId, phoneNumberId: alternatePhoneId, lastInboundAt: new Date() },
    });
    const routeConflict = await post({ key: crossKey, apiKey: A.apiKey, body: { conversationId: alternateConversation.id, type: "text", text: "Canonical" } });
    check("same key resolving a different business phone route → 409",
      routeConflict.status === 409 && routeConflict.json?.code === "IDEMPOTENCY_KEY_CONFLICT", `status=${routeConflict.status}`);
    check("different-route conflict does not send", metaCalls === crossCalls, `metaCalls=${metaCalls}`);

    // ---- 3. Conflicting payload (content) ----
    const r3 = await post({ key: "K1", apiKey: A.apiKey, body: { to: recipientA, type: "text", text: "Different" } });
    check("conflicting content → 409 IDEMPOTENCY_KEY_CONFLICT",
      r3.status === 409 && r3.json?.code === "IDEMPOTENCY_KEY_CONFLICT", `status=${r3.status} code=${r3.json?.code}`);
    check("conflicting content does not send or create", metaCalls === metaAfterCanonicalChecks && (await countKey(A.tenantId, "K1")) === 1);

    // ---- 4. Conflicting payload (recipient) ----
    const r4 = await post({ key: "K1", apiKey: A.apiKey, body: { to: recipientA2, type: "text", text: "Hello" } });
    check("conflicting recipient → 409 (no cross-recipient reuse)",
      r4.status === 409 && r4.json?.code === "IDEMPOTENCY_KEY_CONFLICT", `status=${r4.status}`);
    check("conflicting recipient does not send", metaCalls === metaAfterCanonicalChecks, `metaCalls=${metaCalls}`);

    // ---- 5. Unauthenticated duplicate ----
    const r5 = await post({ key: "K1", apiKey: null, body: { to: recipientA, type: "text", text: "Hello" } });
    check("unauthenticated duplicate is rejected with 401", r5.status === 401, `status=${r5.status}`);
    check("unauthenticated duplicate performs no provider transmission", metaCalls === metaAfterCanonicalChecks);

    // ---- 6. Cross-tenant isolation with the same key ----
    const rB = await post({ key: "K1", apiKey: B.apiKey, body: { to: recipientB, type: "text", text: "Hello" } });
    check("different tenant with the same key is accepted independently", rB.status === 201, `status=${rB.status}`);
    check("different tenant never reuses another tenant's message identity", rB.json?.id !== r1.json?.id);
    check("each tenant owns exactly one message for the shared key",
      (await countKey(A.tenantId, "K1")) === 1 && (await countKey(B.tenantId, "K1")) === 1);
    check("cross-tenant request performed its own provider transmission", metaCalls === metaAfterCanonicalChecks + 1, `metaCalls=${metaCalls}`);

    // ---- 7. Concurrent identical requests ----
    const beforeConcurrent = metaCalls;
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () =>
        post({ key: "K7", apiKey: A.apiKey, body: { to: recipientA, type: "text", text: "concurrent" } }),
      ),
    );
    const created = concurrent.filter((r) => r.status === 201);
    const ids = new Set(concurrent.map((r) => r.json?.id).filter(Boolean));
    check("concurrent identical requests produce exactly one creator", created.length === 1, `201s=${created.length}`);
    check("concurrent identical requests all resolve to one identity", ids.size === 1, `distinct=${ids.size}`);
    check("concurrent identical requests produce exactly one provider transmission", metaCalls - beforeConcurrent === 1, `delta=${metaCalls - beforeConcurrent}`);
    check("concurrent identical requests create exactly one logical message", (await countKey(A.tenantId, "K7")) === 1);

    // ---- 8. Durable binding across an independent client (restart durability) ----
    const { PrismaClient } = await import("@/generated/prisma/client");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const fresh = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    try {
      const row = await fresh.message.findUnique({
        where: { tenantId_idempotencyKey: { tenantId: A.tenantId, idempotencyKey: "K1" } },
      });
      check("idempotency binding is durable in PostgreSQL (independent client)", row?.id === r1.json?.id, `row=${row?.id ?? "none"}`);
    } finally {
      await fresh.$disconnect();
    }
    const r8 = await post({ key: "K1", apiKey: A.apiKey, body: { to: recipientA, type: "text", text: "Hello" } });
    check("duplicate after independent re-read still reuses the original identity",
      r8.status === 200 && r8.json?.id === r1.json?.id, `status=${r8.status}`);

    // ---- 9. Async (durable outbox) path ----
    process.env.WHATSAPP_OUTBOUND_ASYNC_ENABLED = "true";
    const outboxBefore = await countOutbox(A.tenantId);
    const metaBeforeAsync = metaCalls;
    const a1 = await post({ key: "K9", apiKey: A.apiKey, body: { to: recipientA, type: "text", text: "async" } });
    check("first async keyed request returns 202 accepted", a1.status === 202 && a1.json?.accepted === true, `status=${a1.status}`);
    const a2 = await post({ key: "K9", apiKey: A.apiKey, body: { to: recipientA, type: "text", text: "async" } });
    check("async duplicate reuses the original identity without a new job",
      a2.status === 200 && a2.json?.duplicate === true && a2.json?.id === a1.json?.id);
    check("async duplicate creates exactly one logical message", (await countKey(A.tenantId, "K9")) === 1);
    check("async request enqueues exactly one outbox job", (await countOutbox(A.tenantId)) - outboxBefore === 1, `delta=${(await countOutbox(A.tenantId)) - outboxBefore}`);
    check("async path performs no inline provider transmission", metaCalls === metaBeforeAsync);
    delete process.env.WHATSAPP_OUTBOUND_ASYNC_ENABLED;

    // ---- 10. Failed/pending acknowledgement is never fabricated ----
    metaFailuresRemaining = 1;
    const metaBeforeFail = metaCalls;
    const f1 = await post({ key: "K10", apiKey: A.apiKey, body: { to: recipientA, type: "text", text: "flaky" } });
    check("failed provider submission does not return success", f1.status >= 400, `status=${f1.status}`);
    const failedRow = await prisma.message.findFirst({ where: { tenantId: A.tenantId, idempotencyKey: "K10" } });
    check("failed submission is persisted as FAILED (no fabricated SENT)", failedRow?.status === "FAILED", `status=${failedRow?.status}`);
    const f2 = await post({ key: "K10", apiKey: A.apiKey, body: { to: recipientA, type: "text", text: "flaky" } });
    check(
      "duplicate of a failed submission returns verified state without message_id",
      f2.status === 200 && f2.json?.duplicate === true && f2.json?.message_status === "FAILED" && f2.json?.message_id === undefined,
      `status=${f2.status} message_status=${f2.json?.message_status}`,
    );
    check("duplicate of a failed submission is not automatically retried", metaCalls === metaBeforeFail + 1, `metaCalls=${metaCalls}`);

    // ---- 11. No-key legacy behavior ----
    const beforeLegacy = metaCalls;
    const n1 = await post({ key: null, apiKey: A.apiKey, body: { to: recipientA, type: "text", text: "legacy" } });
    const n2 = await post({ key: null, apiKey: A.apiKey, body: { to: recipientA, type: "text", text: "legacy" } });
    check("unkeyed request keeps legacy 201 + message_id", n1.status === 201 && Boolean(n1.json?.message_id) && n1.json?.duplicate === undefined);
    check("unkeyed requests are not deduplicated (legacy behavior preserved)", n2.status === 201 && n2.json?.id !== n1.json?.id);
    check("unkeyed requests each reach the provider", metaCalls - beforeLegacy === 2, `delta=${metaCalls - beforeLegacy}`);

    // ---- 12. Database uniqueness enforced directly ----
    const idx = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'Message' AND indexname = 'Message_tenantId_idempotencyKey_key'`,
    );
    check("tenant-scoped unique index exists", idx.length === 1 && idx[0].indexname === "Message_tenantId_idempotencyKey_key");
    const conv = await prisma.conversation.findFirstOrThrow({ where: { tenantId: A.tenantId, phoneNumberId: A.phoneId } });
    const dbMsg = await prisma.message.create({
      data: { tenantId: A.tenantId, conversationId: conv.id, direction: "OUT", type: "TEXT", status: "PENDING", idempotencyKey: "DB-UNIQUE", idempotencyFingerprint: "fp" },
    });
    let rejected = false;
    try {
      await prisma.message.create({
        data: { tenantId: A.tenantId, conversationId: conv.id, direction: "OUT", type: "TEXT", status: "PENDING", idempotencyKey: "DB-UNIQUE", idempotencyFingerprint: "fp2" },
      });
    } catch (error) {
      rejected = (error as { code?: string })?.code === "P2002";
    }
    check("database rejects a second message for the same (tenantId, key)", rejected);
    await prisma.message.delete({ where: { id: dbMsg.id } }).catch(() => {});
  } finally {
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM "ApiKey" WHERE "id" LIKE $1`, `${runId}%`);
      await prisma.$executeRawUnsafe(`DELETE FROM "OutboxEvent" WHERE "tenantId" LIKE $1`, `${runId}%`);
      await prisma.$executeRawUnsafe(`DELETE FROM "CanonicalEventOutbox" WHERE "tenantId" LIKE $1`, `${runId}%`);
      await prisma.$executeRawUnsafe(`DELETE FROM "OutboundSendAttempt" WHERE "tenantId" LIKE $1`, `${runId}%`);
      await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "tenantId" LIKE $1`, `${runId}%`);
      await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "tenantId" LIKE $1`, `${runId}%`);
      await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "tenantId" LIKE $1`, `${runId}%`);
      await prisma.$executeRawUnsafe(`DELETE FROM "PhoneNumber" WHERE "id" LIKE $1`, `${runId}%`);
      await prisma.$executeRawUnsafe(`DELETE FROM "WabaAccount" WHERE "id" LIKE $1`, `${runId}%`);
      await prisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" LIKE $1`, `${runId}%`);
    } catch {
      /* ignore cleanup errors */
    }
    globalThis.fetch = realFetch;
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length) {
    console.error(`\n${failed.length} FAILED:`);
    for (const f of failed) console.error(`  - ${f.label}${f.detail ? ` → ${f.detail}` : ""}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
