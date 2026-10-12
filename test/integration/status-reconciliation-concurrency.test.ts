/**
 * WA-ERA4-06 (rework) — Genuinely concurrent PostgreSQL verification.
 *
 * Run with:
 *   DATABASE_URL=postgresql://... npx tsx \
 *     test/integration/status-reconciliation-concurrency.test.ts
 *
 * This test exercises genuinely overlapping reconciliation operations
 * against the same `Message` row, using two independent Prisma
 * clients (each with its own connection pool) so the database
 * transactions actually overlap on the PostgreSQL server. The
 * production `reconcileStatusEvent` is called directly with the
 * `prismaClient` injection point so the test exercises the exact
 * code path, not a hand-rolled replica.
 *
 * The publication side is verified by attaching a fake WebSocket
 * to the Hub's `connections` set (created lazily on the first
 * `publish()`) and counting the JSON frames the Hub delivers to
 * each fake client. This is the same path real browser clients
 * take, without the HTTP server handshake.
 *
 * The tests prove the canonical state machine survives concurrent
 * reconciliation and that the SERIALIZABLE isolation + bounded
 * retry protects against duplicate logical mutations:
 *
 *   A. Concurrent DELIVERED and READ on the same message
 *      (starting from SENT). Two webhooks arrive simultaneously:
 *      one says DELIVERED, the other says READ. The final
 *      canonical status must be READ (the higher rank). The
 *      publication history may contain BOTH events because both
 *      are genuine canonical transitions: the second transaction
 *      sees the first's SENT->DELIVERED commit and advances to
 *      READ. The invariant the row lock protects is that no
 *      transition is lost or reordered in a way that leaves the
 *      DB regressed.
 *
 *   B. Concurrent DELIVERED and READ on the same message
 *      (starting from DELIVERED). The DELIVERED webhook is a
 *      no-op (already DELIVERED); only the READ is a transition.
 *      Final must be READ; exactly one publish.
 *
 *   C. Concurrent duplicate READ events on the same message
 *      (starting from DELIVERED). The critical case: two
 *      concurrent attempts to advance to READ. Without the row
 *      lock, both transactions would read DELIVERED, both
 *      compute READ, both report changed=true, and the
 *      message:status event would be published twice for the
 *      same logical transition. The row lock forces the second
 *      transaction to wait, re-read the post-commit status, and
 *      observe changed=false.
 *
 *   D. Concurrent FAILED and READ on the same message
 *      (starting from DELIVERED). FAILED must not regress READ;
 *      final status is READ or DELIVERED, never FAILED.
 *
 *   E. Concurrent updates from different tenants.
 *      Tenant A's reconciliation does NOT mutate Tenant B's row
 *      and vice versa; each tenant receives exactly one
 *      message:status event for its own message, never the other.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { WebSocket as WsWebSocket } from "ws";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const runId = `status_conc_${randomUUID().slice(0, 8)}`;

type Frame = { type: string; payload: unknown };

class FakeWs extends EventEmitter {
  public readyState: number = 1; // OPEN
  public sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
}

async function main() {
  const checks: { label: string; ok: boolean; detail?: string }[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checks.push({ label, ok, detail });
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
  };

  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const realtime = await import("@/server/realtime");
  const { reconcileStatusEvent } = await import(
    "@/lib/whatsapp/status/reconciliation"
  );

  // Two independent Prisma clients so each reconciliation uses a
  // separate connection from a separate pool — required for the
  // transactions to actually overlap on the PostgreSQL server.
  function makeClient() {
    return new PrismaClient({
      adapter: new PrismaPg({ connectionString: baseUrl }),
      log: ["error"],
    });
  }
  const clientA = makeClient();
  const clientB = makeClient();

  // Force Hub creation (lazy on first publish), then attach fake
  // clients to the Hub's connection set. Each fake client
  // represents one tenant's WebSocket subscription.
  const hub = (realtime as unknown as { getHub?: () => unknown }).getHub?.()
    ?? (globalThis as unknown as { __waRealtime?: { connections: Set<unknown> } }).__waRealtime;
  if (!hub || typeof (hub as { connections?: Set<unknown> }).connections === "undefined") {
    // Trigger Hub creation by publishing a no-op event. publish()
    // calls getHub() which initializes globalThis.__waRealtime.
    realtime.publish({ type: "message:status", payload: {} }, "init");
  }
  const hubAfter = (globalThis as unknown as { __waRealtime: { connections: Set<unknown> } }).__waRealtime;
  if (!hubAfter) throw new Error("Hub not initialized");

  // Each scenario gets its own fake clients so we can reset
  // captured frames per case. Fake clients are scoped to the
  // tenantId the scenario uses.
  function attachClient(tenantId: string): { ws: FakeWs; frames: () => Frame[] } {
    const ws = new FakeWs();
    hubAfter.connections.add({
      ws: ws as unknown as WsWebSocket,
      userId: `${runId}_user_${Math.random().toString(36).slice(2, 8)}`,
      tenantId,
      cookie: "test",
      revalidate: setInterval(() => {}, 1 << 30),
    });
    return {
      ws,
      frames: () =>
        ws.sent.map((s) => {
          try {
            return JSON.parse(s) as Frame;
          } catch {
            return { type: "invalid", payload: s };
          }
        }),
    };
  }

  function clearConnections() {
    for (const conn of hubAfter.connections) {
      const c = conn as { revalidate?: ReturnType<typeof setInterval>; ws?: { close?: () => void } };
      if (c.revalidate) clearInterval(c.revalidate);
      try {
        c.ws?.close?.();
      } catch {
        /* ignore */
      }
    }
    hubAfter.connections.clear();
  }

  // ---- Helpers --------------------------------------------------------------

  function buildPayload(waMessageId: string, providerStatus: string, metaPhone: string) {
    return {
      object: "whatsapp_business_account",
      entry: [
        {
          id: `${runId}_meta_waba`,
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: metaPhone },
                statuses: [
                  {
                    id: waMessageId,
                    status: providerStatus,
                    timestamp: "1800000000",
                    recipient_id: "5551234",
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  async function seedFullStack(
    suffix: string,
    initialStatus: "PENDING" | "SENT" | "DELIVERED",
  ) {
    const tenantId = `${runId}_${suffix}_tenant`;
    const wabaId = `${runId}_${suffix}_waba`;
    const phoneId = `${runId}_${suffix}_phone`;
    const metaPhone = `${runId}_${suffix}_meta_phone`;
    const convId = `${runId}_${suffix}_conv`;
    const msgId = `${runId}_${suffix}_msg`;
    const waMsgId = `wamid.${runId}_${suffix}.1`;

    await clientA.$executeRawUnsafe(
      `INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, $2, NOW())`,
      tenantId,
      tenantId,
    );
    await clientA.$executeRawUnsafe(
      `INSERT INTO "WabaAccount" ("id", "tenantId", "metaWabaId", "name", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      wabaId,
      tenantId,
      `${runId}_${suffix}_meta_waba`,
      "test",
    );
    await clientA.$executeRawUnsafe(
      `INSERT INTO "PhoneNumber" ("id", "wabaAccountId", "metaPhoneNumberId", "displayPhone", "verifiedName", "updatedAt") VALUES ($1, $2, $3, $4, $5, NOW())`,
      phoneId,
      wabaId,
      metaPhone,
      "+1234567890",
      "Test",
    );
    await clientA.$executeRawUnsafe(
      `INSERT INTO "Contact" ("id", "waId", "name", "createdAt", "updatedAt") VALUES ($1, $2, $3, NOW(), NOW())`,
      `${runId}_${suffix}_contact`,
      `${runId}_${suffix}_waid`,
      "Test",
    );
    await clientA.$executeRawUnsafe(
      `INSERT INTO "Conversation" ("id", "tenantId", "contactId", "phoneNumberId", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      convId,
      tenantId,
      `${runId}_${suffix}_contact`,
      phoneId,
    );
    await clientA.$executeRawUnsafe(
      `INSERT INTO "Message" ("id", "tenantId", "conversationId", "direction", "type", "status", "waMessageId", "text", "timestamp") VALUES ($1, $2, $3, 'OUT', 'TEXT', $4, $5, 'hi', NOW())`,
      msgId,
      tenantId,
      convId,
      initialStatus,
      waMsgId,
    );
    await clientA.$executeRawUnsafe(
      `INSERT INTO "OutboundSendAttempt" ("id", "messageId", "tenantId", "waMessageId", "state", "updatedAt") VALUES ($1, $2, $3, $4, 'PENDING', NOW())`,
      `${runId}_${suffix}_attempt`,
      msgId,
      tenantId,
      waMsgId,
    );

    return { tenantId, wabaId, phoneId, metaPhone, convId, msgId, waMsgId };
  }

  async function cleanup(suffix: string) {
    const tenantId = `${runId}_${suffix}_tenant`;
    await clientA.$executeRawUnsafe(
      `DELETE FROM "OutboundSendAttempt" WHERE "tenantId" = $1`,
      tenantId,
    );
    await clientA.$executeRawUnsafe(
      `DELETE FROM "Message" WHERE "tenantId" = $1`,
      tenantId,
    );
    await clientA.$executeRawUnsafe(
      `DELETE FROM "Conversation" WHERE "tenantId" = $1`,
      tenantId,
    );
    await clientA.$executeRawUnsafe(
      `DELETE FROM "Contact" WHERE "id" = $1`,
      `${runId}_${suffix}_contact`,
    );
    await clientA.$executeRawUnsafe(
      `DELETE FROM "PhoneNumber" WHERE "id" = $1`,
      `${runId}_${suffix}_phone`,
    );
    await clientA.$executeRawUnsafe(
      `DELETE FROM "WabaAccount" WHERE "id" = $1`,
      `${runId}_${suffix}_waba`,
    );
    await clientA.$executeRawUnsafe(
      `DELETE FROM "Tenant" WHERE "id" = $1`,
      tenantId,
    );
  }

  async function currentStatus(msgId: string) {
    const row = await clientA.message.findUnique({
      where: { id: msgId },
      select: { status: true },
    });
    return row?.status ?? null;
  }

  async function makeWebhookEvent(
    waMessageId: string,
    providerStatus: string,
    metaPhone: string,
  ) {
    return clientA.webhookEvent.create({
      data: {
        payload: buildPayload(waMessageId, providerStatus, metaPhone),
        signatureValid: true,
        processedOk: false,
        eventSummary: "accepted durable status receipt",
      },
    });
  }

  // ---- Test cases -----------------------------------------------------------

  try {
    // ----- A. Concurrent DELIVERED and READ on SENT -----
    // Both are genuine canonical transitions: SENT -> DELIVERED
    // (rank 1 -> 2) and DELIVERED -> READ (rank 2 -> 3). The row
    // lock forces them to commit serially; the second sees the
    // first's post-commit state and advances. Both transitions
    // are valid and both publish a message:status. The invariant
    // is that the final DB state is READ (the highest rank) and
    // no transition is lost.
    {
      const seed = await seedFullStack("A", "SENT");
      clearConnections();
      const client = attachClient(seed.tenantId);
      const evtDelivered = await makeWebhookEvent(seed.waMsgId, "delivered", seed.metaPhone);
      const evtRead = await makeWebhookEvent(seed.waMsgId, "read", seed.metaPhone);

      const [r1, r2] = await Promise.all([
        reconcileStatusEvent({
          webhookEventId: evtDelivered.id,
          tenantId: seed.tenantId,
          wabaAccountId: seed.wabaId,
          phoneNumberId: seed.phoneId,
          messageId: seed.msgId,
          waMessageId: seed.waMsgId,
          prismaClient: clientA,
        }),
        reconcileStatusEvent({
          webhookEventId: evtRead.id,
          tenantId: seed.tenantId,
          wabaAccountId: seed.wabaId,
          phoneNumberId: seed.phoneId,
          messageId: seed.msgId,
          waMessageId: seed.waMsgId,
          prismaClient: clientB,
        }),
      ]);

      const finalStatus = await currentStatus(seed.msgId);
      check(
        "A. final canonical status is READ",
        finalStatus === "READ",
        `final=${finalStatus} r1=${r1.status}/changed=${r1.changed} r2=${r2.status}/changed=${r2.changed}`,
      );
      check(
        "A. never regresses below SENT (the initial state)",
        finalStatus === "SENT" || finalStatus === "DELIVERED" || finalStatus === "READ",
        `final=${finalStatus}`,
      );
      const statusFrames = client.frames().filter((f) => f.type === "message:status");
      // The set of published statuses must be a prefix of the
      // canonical advance sequence ending in READ. At most two
      // publishes (DELIVERED and/or READ), never a regression to
      // a lower rank.
      const publishedStatuses = statusFrames.map(
        (f) => (f.payload as { status?: string })?.status,
      );
      const rank: Record<string, number> = {
        PENDING: 0,
        SENT: 1,
        DELIVERED: 2,
        READ: 3,
        FAILED: 1,
        RECEIVED: 3,
      };
      const orderedRanks = publishedStatuses.map((s) => rank[s ?? ""] ?? -1);
      const isMonotonic = orderedRanks.every(
        (r, i) => i === 0 || r >= orderedRanks[i - 1],
      );
      check(
        "A. published statuses are monotonic non-decreasing",
        isMonotonic,
        `published=${publishedStatuses.join(",")}`,
      );
      check(
        "A. last published status is the final canonical status",
        publishedStatuses[publishedStatuses.length - 1] === "READ",
        `published=${publishedStatuses.join(",")} final=${finalStatus}`,
      );
      await cleanup("A");
    }

    // ----- B. Concurrent DELIVERED (no-op) and READ on DELIVERED -----
    // One webhook is a no-op (DELIVERED on a DELIVERED row), the
    // other advances to READ. The row lock makes the no-op wait
    // for the READ to commit, then observes the post-commit READ
    // and reports changed=false. Exactly one publish.
    {
      const seed = await seedFullStack("B", "DELIVERED");
      clearConnections();
      const client = attachClient(seed.tenantId);
      const evtDelivered = await makeWebhookEvent(seed.waMsgId, "delivered", seed.metaPhone);
      const evtRead = await makeWebhookEvent(seed.waMsgId, "read", seed.metaPhone);

      const [r1, r2] = await Promise.all([
        reconcileStatusEvent({
          webhookEventId: evtDelivered.id,
          tenantId: seed.tenantId,
          wabaAccountId: seed.wabaId,
          phoneNumberId: seed.phoneId,
          messageId: seed.msgId,
          waMessageId: seed.waMsgId,
          prismaClient: clientA,
        }),
        reconcileStatusEvent({
          webhookEventId: evtRead.id,
          tenantId: seed.tenantId,
          wabaAccountId: seed.wabaId,
          phoneNumberId: seed.phoneId,
          messageId: seed.msgId,
          waMessageId: seed.waMsgId,
          prismaClient: clientB,
        }),
      ]);

      const finalStatus = await currentStatus(seed.msgId);
      check(
        "B. final canonical status is READ",
        finalStatus === "READ",
        `final=${finalStatus} r1=${r1.status}/changed=${r1.changed} r2=${r2.status}/changed=${r2.changed}`,
      );
      check(
        "B. exactly one of the two reconcile calls reports changed=true",
        (r1.changed ? 1 : 0) + (r2.changed ? 1 : 0) === 1,
        `r1.changed=${r1.changed} r2.changed=${r2.changed}`,
      );
      const statusFrames = client.frames().filter((f) => f.type === "message:status");
      check(
        "B. exactly one message:status published to the tenant",
        statusFrames.length === 1,
        `n=${statusFrames.length}`,
      );
      await cleanup("B");
    }

    // ----- C. Concurrent duplicate READ events on DELIVERED -----
    {
      const seed = await seedFullStack("C", "DELIVERED");
      clearConnections();
      const client = attachClient(seed.tenantId);
      const evtRead1 = await makeWebhookEvent(seed.waMsgId, "read", seed.metaPhone);
      const evtRead2 = await makeWebhookEvent(seed.waMsgId, "read", seed.metaPhone);

      const [r1, r2] = await Promise.all([
        reconcileStatusEvent({
          webhookEventId: evtRead1.id,
          tenantId: seed.tenantId,
          wabaAccountId: seed.wabaId,
          phoneNumberId: seed.phoneId,
          messageId: seed.msgId,
          waMessageId: seed.waMsgId,
          prismaClient: clientA,
        }),
        reconcileStatusEvent({
          webhookEventId: evtRead2.id,
          tenantId: seed.tenantId,
          wabaAccountId: seed.wabaId,
          phoneNumberId: seed.phoneId,
          messageId: seed.msgId,
          waMessageId: seed.waMsgId,
          prismaClient: clientB,
        }),
      ]);

      const finalStatus = await currentStatus(seed.msgId);
      check(
        "C. final canonical status is READ",
        finalStatus === "READ",
        `final=${finalStatus}`,
      );
      // The critical invariant: exactly one logical transition
      // is committed. SERIALIZABLE + bounded retry forces the
      // second transaction to fail with 40001, retry, then
      // observe the post-commit status and report changed=false.
      const changedCount = (r1.changed ? 1 : 0) + (r2.changed ? 1 : 0);
      check(
        "C. exactly one of two concurrent READs reports changed=true",
        changedCount === 1,
        `changedCount=${changedCount} r1=${r1.changed} r2=${r2.changed}`,
      );
      const statusFrames = client.frames().filter((f) => f.type === "message:status");
      check(
        "C. exactly one message:status published for the transition",
        statusFrames.length === 1,
        `n=${statusFrames.length}`,
      );
      await cleanup("C");
    }

    // ----- D. Concurrent FAILED and READ on DELIVERED -----
    {
      const seed = await seedFullStack("D", "DELIVERED");
      clearConnections();
      attachClient(seed.tenantId);
      const evtFailed = await makeWebhookEvent(seed.waMsgId, "failed", seed.metaPhone);
      const evtRead = await makeWebhookEvent(seed.waMsgId, "read", seed.metaPhone);

      const [r1, r2] = await Promise.all([
        reconcileStatusEvent({
          webhookEventId: evtFailed.id,
          tenantId: seed.tenantId,
          wabaAccountId: seed.wabaId,
          phoneNumberId: seed.phoneId,
          messageId: seed.msgId,
          waMessageId: seed.waMsgId,
          prismaClient: clientA,
        }),
        reconcileStatusEvent({
          webhookEventId: evtRead.id,
          tenantId: seed.tenantId,
          wabaAccountId: seed.wabaId,
          phoneNumberId: seed.phoneId,
          messageId: seed.msgId,
          waMessageId: seed.waMsgId,
          prismaClient: clientB,
        }),
      ]);

      const finalStatus = await currentStatus(seed.msgId);
      check(
        "D. final canonical status is NOT FAILED",
        finalStatus !== "FAILED",
        `final=${finalStatus} r1=${r1.status}/changed=${r1.changed} r2=${r2.status}/changed=${r2.changed}`,
      );
      check(
        "D. final canonical status is READ or DELIVERED",
        finalStatus === "READ" || finalStatus === "DELIVERED",
        `final=${finalStatus}`,
      );
      await cleanup("D");
    }

    // ----- E. Concurrent updates from different tenants -----
    {
      const seedA = await seedFullStack("E_A", "PENDING");
      const seedB = await seedFullStack("E_B", "PENDING");
      clearConnections();
      const clientAHub = attachClient(seedA.tenantId);
      const clientBHub = attachClient(seedB.tenantId);
      const evtA = await makeWebhookEvent(seedA.waMsgId, "delivered", seedA.metaPhone);
      const evtB = await makeWebhookEvent(seedB.waMsgId, "read", seedB.metaPhone);

      const [r1, r2] = await Promise.all([
        reconcileStatusEvent({
          webhookEventId: evtA.id,
          tenantId: seedA.tenantId,
          wabaAccountId: seedA.wabaId,
          phoneNumberId: seedA.phoneId,
          messageId: seedA.msgId,
          waMessageId: seedA.waMsgId,
          prismaClient: clientA,
        }),
        reconcileStatusEvent({
          webhookEventId: evtB.id,
          tenantId: seedB.tenantId,
          wabaAccountId: seedB.wabaId,
          phoneNumberId: seedB.phoneId,
          messageId: seedB.msgId,
          waMessageId: seedB.waMsgId,
          prismaClient: clientB,
        }),
      ]);

      const finalA = await currentStatus(seedA.msgId);
      const finalB = await currentStatus(seedB.msgId);
      check(
        "E. tenant A final status is DELIVERED (its own target)",
        finalA === "DELIVERED" && r1.status === "DELIVERED" && r1.changed === true,
        `finalA=${finalA} r1=${r1.status}/changed=${r1.changed}`,
      );
      check(
        "E. tenant B final status is READ (its own target)",
        finalB === "READ" && r2.status === "READ" && r2.changed === true,
        `finalB=${finalB} r2=${r2.status}/changed=${r2.changed}`,
      );
      const pubsA = clientAHub.frames().filter((f) => f.type === "message:status");
      const pubsB = clientBHub.frames().filter((f) => f.type === "message:status");
      check(
        "E. tenant A receives exactly one message:status for its own message",
        pubsA.length === 1 &&
          (pubsA[0]?.payload as { conversationId?: string })?.conversationId === seedA.convId,
        `n=${pubsA.length}`,
      );
      check(
        "E. tenant B receives exactly one message:status for its own message",
        pubsB.length === 1 &&
          (pubsB[0]?.payload as { conversationId?: string })?.conversationId === seedB.convId,
        `n=${pubsB.length}`,
      );
      // Cross-tenant: A's payload must reference A's conversation,
      // never B's; and vice versa.
      check(
        "E. tenant A does NOT see tenant B's conversationId",
        !pubsA.some((f) => (f.payload as { conversationId?: string })?.conversationId === seedB.convId),
      );
      check(
        "E. tenant B does NOT see tenant A's conversationId",
        !pubsB.some((f) => (f.payload as { conversationId?: string })?.conversationId === seedA.convId),
      );
      await cleanup("E_A");
      await cleanup("E_B");
    }
  } finally {
    clearConnections();
    await clientA.$disconnect();
    await clientB.$disconnect();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
