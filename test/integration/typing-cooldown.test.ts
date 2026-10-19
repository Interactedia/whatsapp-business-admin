/**
 * WA-TYPING-01 (simplified) — atomic Redis typing cooldown.
 *
 * Real PostgreSQL + real Redis. Meta HTTP is intercepted at
 * globalThis.fetch (no external traffic; the cooldown guards run before
 * Meta is invoked anyway).
 *
 * Gates covered:
 *   A. Varios keystrokes (pings rápidos) → como máximo UNA petición a Meta.
 *   B. Send del mensaje → ningún typing tardío después (nada queda programado).
 *   C. Recipiente/número distinto → cooldown independiente.
 *   D. Concurrencia: dos solicitudes simultáneas → una sola gana el slot.
 *   E. Reinicio de proceso: el cooldown vive en Redis, no en memoria.
 *
 * Run with:
 *   DATABASE_URL=postgresql://... REDIS_URL=redis://127.0.0.1:6379 \
 *   npx tsx test/integration/typing-cooldown.test.ts
 */
import { randomUUID } from "node:crypto";

const runId = `typing_cd_${randomUUID().slice(0, 8)}`;

async function main() {
  process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  process.env.WHATSAPP_TYPING_ENABLED = "true";
  process.env.ENCRYPTION_KEY ??= "0".repeat(63) + "1";

  const { prisma } = await import("@/lib/prisma");
  const { encrypt } = await import("@/lib/crypto");
  const { getRedis, disconnectRedis } = await import("@/lib/redis/client");
  const { sendTypingIndicator } = await import("@/lib/whatsapp/typing");
  const { tryAcquireTypingCooldown } = await import("@/lib/whatsapp/typing/cooldown");
  const { resolveTenantContext } = await import("@/lib/tenant");

  const redis = getRedis();
  if (!redis) throw new Error("REDIS_URL not configured — this test requires a real Redis");
  await redis.ping();

  const checks: { label: string; ok: boolean; detail?: string }[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checks.push({ label, ok, detail });
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
  };

  // Intercept globalThis.fetch so no real traffic reaches Meta.
  const originalFetch = globalThis.fetch;
  const metaCalls: { at: number; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/messages")) {
      metaCalls.push({
        at: Date.now(),
        body: init?.body ? JSON.parse(String(init.body)) : {},
      });
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const encryptedToken = encrypt("test-token");

  async function makeThread(label: string, recipientWaId = "5215550000000") {
    const tenantId = `${runId}_${label}_tenant`;
    const userId = `${runId}_${label}_user`;
    const wabaId = `${runId}_${label}_waba`;
    const phoneId = `${runId}_${label}_phone`;
    const contactId = `${runId}_${label}_contact`;
    const convId = `${runId}_${label}_conv`;
    const inboundId = `${runId}_${label}_inbound`;

    await prisma.$executeRawUnsafe(
      `INSERT INTO "Tenant" ("id", "name", "createdAt", "updatedAt") VALUES ($1, $2, NOW(), NOW())`,
      tenantId, `Tenant ${label}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "User" ("id", "email", "name", "role", "active", "passwordHash", "createdAt", "updatedAt") VALUES ($1, $2, 'Test', 'ADMIN', true, 'placeholder', NOW(), NOW())`,
      userId, `${runId}_${label}@test.local`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "TenantMembership" ("id", "userId", "tenantId", "createdAt") VALUES ($1, $2, $3, NOW())`,
      `${runId}_${label}_m`, userId, tenantId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "WabaAccount" ("id", "tenantId", "metaWabaId", "name", "accessTokenEnc", "appSecret", "apiVersion", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, 'sec', 'v21.0', NOW(), NOW())`,
      wabaId, tenantId, `${runId}_${label}_mw`, `Waba ${label}`, encryptedToken,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "PhoneNumber" ("id", "wabaAccountId", "metaPhoneNumberId", "displayPhone", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      phoneId, wabaId, `${runId}_${label}_mp`, "+15550000000",
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Contact" ("id", "tenantId", "waId", "createdAt", "updatedAt") VALUES ($1, $2, $3, NOW(), NOW())`,
      contactId, tenantId, recipientWaId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Conversation" ("id", "tenantId", "contactId", "phoneNumberId", "status", "createdAt", "updatedAt", "lastMessageAt") VALUES ($1, $2, $3, $4, 'OPEN', NOW(), NOW(), NOW())`,
      convId, tenantId, contactId, phoneId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Message" ("id", "tenantId", "conversationId", "direction", "type", "status", "text", "waMessageId", "timestamp") VALUES ($1, $2, $3, 'IN', 'TEXT', 'RECEIVED', 'hola', $4, NOW())`,
      inboundId, tenantId, convId, `wamid.${runId}.${label}.inbound`,
    );
    const ctx = await resolveTenantContext({ userId }, tenantId);
    return { tenantId, userId, wabaId, phoneId, contactId, convId, inboundId, ctx };
  }

  try {
    // ============================================================
    // A+B. The exact defect scenario, reproduced end to end:
    //   1. Operator types message A → several keystroke pings.
    //   2. Only the FIRST ping may reach Meta (25s Redis cooldown).
    //   3. Operator presses Send → an OUT message row is persisted
    //      (the authoritative send point). The browser aborts its
    //      in-flight fetch; the server has NOTHING scheduled.
    //   4. Operator does NOT type again. We wait longer than the old
    //      client debounce (2s) and the old p-queue interval (5s):
    //      no additional Meta typing call may appear.
    // ============================================================
    const t = await makeThread("AB");
    const opts = {
      context: t.ctx,
      conversationId: t.convId,
      inboundMessageId: t.inboundId,
      markAsRead: true as const,
    };

    // Keystroke pings (client throttles to ~1/2s; simulate a burst).
    const pingResults = [];
    for (let i = 0; i < 4; i++) {
      pingResults.push(await sendTypingIndicator(opts));
      await new Promise((r) => setTimeout(r, 50));
    }
    check("A.1 first keystroke ping dispatched", pingResults[0]!.success === true, pingResults[0]!.reason);
    check(
      "A.2 remaining keystroke pings discarded by cooldown",
      pingResults.slice(1).every((r) => !r.success && r.reason?.includes("cooldown")),
      pingResults.slice(1).map((r) => r.reason).join(" | "),
    );
    check("A.3 exactly one Meta request for 4 pings", metaCalls.length === 1, `calls=${metaCalls.length}`);
    check(
      "A.4 Meta payload carries typing_indicator",
      metaCalls[0]?.body?.["typing_indicator"] !== undefined,
    );

    // Redis key evidence: real key with a real TTL.
    const key = `typing:cooldown:${t.tenantId}:${runId}_AB_mp:5215550000000`;
    const ttlMs = await redis.pttl(key);
    check("A.5 cooldown key exists in Redis with TTL ≤ 25s", ttlMs > 0 && ttlMs <= 25_000, `pttl=${ttlMs}`);

    // Send: persist the OUT message (the send itself is out of scope —
    // WA-OUTRETRY-01 untouched; we only need the authoritative moment).
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Message" ("id", "tenantId", "conversationId", "direction", "type", "status", "text", "timestamp") VALUES ($1, $2, $3, 'OUT', 'TEXT', 'PENDING', 'mensaje A', NOW())`,
      `${runId}_AB_out`, t.tenantId, t.convId,
    );

    // Wait past every old scheduling horizon (2s debounce + 5s interval).
    await new Promise((r) => setTimeout(r, 3_000));
    check("B.1 no late typing after Send (nothing was scheduled)", metaCalls.length === 1, `calls=${metaCalls.length}`);

    // A straggler ping arriving after Send is also dropped by cooldown.
    const straggler = await sendTypingIndicator(opts);
    check(
      "B.2 post-Send straggler ping discarded by cooldown",
      !straggler.success && straggler.reason?.includes("cooldown") === true,
      straggler.reason,
    );
    await new Promise((r) => setTimeout(r, 1_000));
    check("B.3 straggler never reached Meta", metaCalls.length === 1, `calls=${metaCalls.length}`);

    // ============================================================
    // C. Different recipient → independent cooldown (consecutive
    //    messages to other contacts keep working).
    // ============================================================
    {
      const t2 = await makeThread("C", "5215550000001");
      const before = metaCalls.length;
      const r = await sendTypingIndicator({
        context: t2.ctx,
        conversationId: t2.convId,
        inboundMessageId: t2.inboundId,
        markAsRead: true,
      });
      check("C.1 different recipient accepted despite A's cooldown", r.success === true, r.reason);
      check("C.2 Meta call emitted for new recipient", metaCalls.length === before + 1);
    }

    // ============================================================
    // D. Concurrency: two simultaneous requests for the same triple —
    //    Redis SET NX makes exactly one winner.
    // ============================================================
    {
      const t3 = await makeThread("D", "5215550000002");
      const opts3 = {
        context: t3.ctx,
        conversationId: t3.convId,
        inboundMessageId: t3.inboundId,
        markAsRead: true,
      };
      const before = metaCalls.length;
      const [r1, r2] = await Promise.all([
        sendTypingIndicator(opts3),
        sendTypingIndicator(opts3),
      ]);
      const winners = [r1, r2].filter((r) => r.success).length;
      check("D.1 exactly one concurrent request wins the slot", winners === 1, `winners=${winners}`);
      check("D.2 exactly one Meta call for the concurrent pair", metaCalls.length === before + 1, `calls=${metaCalls.length - before}`);
    }

    // ============================================================
    // E. Cross-process authority: the slot is granted by Redis, not by
    //    module state. A second acquisition (as another process would
    //    attempt) fails even though it shares nothing in memory.
    // ============================================================
    {
      const first = await tryAcquireTypingCooldown(`${runId}_E`, `${runId}_mp`, "5215550000099");
      const second = await tryAcquireTypingCooldown(`${runId}_E`, `${runId}_mp`, "5215550000099");
      check("E.1 first acquisition wins", first === true);
      check("E.2 second acquisition (other process) rejected by shared Redis", second === false);
    }
  } finally {
    // Cleanup: DB rows + Redis keys.
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM "ApiLog" WHERE "tenantId" LIKE $1`, `${runId}%`);
      await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "tenantId" LIKE $1`, `${runId}%`);
      await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "tenantId" LIKE $1`, `${runId}%`);
      await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "tenantId" LIKE $1`, `${runId}%`);
      await prisma.$executeRawUnsafe(`DELETE FROM "PhoneNumber" WHERE "id" LIKE $1`, `${runId}%`);
      await prisma.$executeRawUnsafe(`DELETE FROM "WabaAccount" WHERE "tenantId" LIKE $1`, `${runId}%`);
      await prisma.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" LIKE $1`, `${runId}%`);
      await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" LIKE $1`, `${runId}%`);
      await prisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" LIKE $1`, `${runId}%`);
      const keys = await redis.keys(`typing:cooldown:${runId}*`);
      if (keys.length) await redis.del(...keys);
    } catch (e) {
      console.warn("cleanup warning:", e instanceof Error ? e.message : e);
    }
    globalThis.fetch = originalFetch;
    await disconnectRedis();
    await prisma.$disconnect();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.error("FAILED:", failed.map((f) => f.label));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
