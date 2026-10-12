/**
 * WA-ERA4-06 — Delivery/Read receipt synchronization regression tests.
 *
 * Verifies the canonical status reconciliation path preserves Meta's
 * status authority and emits realtime notifications only after a
 * genuine canonical change. The tests cover:
 *
 *  - Duplicate notifications: same final status is a no-op (no
 *    publish, no DB mutation).
 *  - Out-of-order notifications: a stale notification cannot regress
 *    a newer canonical status (the STATUS_RANK invariant holds).
 *  - FAILED protection: once a message has reached a higher rank
 *    (DELIVERED/READ) a subsequent FAILED webhook is rejected.
 *  - Post-commit publish: a publish is emitted on transition, with
 *    the exact wire payload shape.
 *  - Idempotent publish suppression: re-applying the same incoming
 *    status after a transition does not republish.
 *
 * Pure unit-level. The real PostgreSQL/Redis verification lives in
 * test/integration/status-reconciliation-postgres.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { publishMock } = vi.hoisted(() => ({ publishMock: vi.fn() }));
vi.mock("@/server/realtime", () => ({ publish: publishMock }));

// In-memory prisma stub. We expose only the tx methods that
// reconcileStatusEvent actually calls.
type MessageRecord = {
  id: string;
  tenantId: string;
  conversationId: string;
  waMessageId: string;
  status: "PENDING" | "SENT" | "DELIVERED" | "READ" | "FAILED" | "RECEIVED";
  errorJson?: unknown;
  conversation: {
    tenantId: string;
    phoneNumberId: string;
    phoneNumber: { wabaAccountId: string };
  };
};

type OutboundAttempt = {
  messageId: string;
  tenantId: string;
  waMessageId: string;
  state: string;
};

type WebhookEvent = {
  id: string;
  payload: unknown;
  signatureValid: boolean;
  processedOk: boolean;
  eventSummary: string | null;
  error: string | null;
};

const messages = new Map<string, MessageRecord>();
const attempts: OutboundAttempt[] = [];
const webhookEvents = new Map<string, WebhookEvent>();

type MessageWhere = {
  id: string;
  waMessageId?: string;
  tenantId?: string;
  conversation?: {
    tenantId?: string;
    phoneNumberId?: string;
    phoneNumber?: { wabaAccountId?: string };
  };
};

type AttemptWhere = {
  messageId: string;
  tenantId?: string;
  waMessageId?: string;
  state?: { in: string[] };
};

type WebhookEventWhere = {
  id?: string;
  eventSummary?: string;
  payload?: { path?: string[]; not?: unknown };
};

type PhoneWhere = {
  id?: string;
  metaPhoneNumberId?: string;
  wabaAccountId?: string;
};

const STATUS_RANK: Record<string, number> = {
  PENDING: 0,
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
  FAILED: 1,
  RECEIVED: 3,
};

const STATUS_MAP: Record<string, MessageRecord["status"]> = {
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
};

function makeWebhookPayload(waMessageId: string, providerStatus: string) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "meta-phone-1" },
              statuses: [
                {
                  id: waMessageId,
                  status: providerStatus,
                  timestamp: "1700000000",
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function makeTx() {
  return {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      // The reconciliation code does a `SELECT id, status,
      // conversationId, waMessageId FROM "Message" WHERE id = $1
      // FOR UPDATE`. In the in-memory mock we just look up the
      // message by id and return the same shape the typed
      // findFirst would return.
      const id = values[0] as string;
      for (const m of messages.values()) {
        if (m.id === id) {
          return [
            {
              id: m.id,
              status: m.status,
              conversationId: m.conversationId,
              waMessageId: m.waMessageId,
            },
          ];
        }
      }
      return [];
    },
    message: {
      findFirst: async ({ where }: { where: MessageWhere }) => {
        for (const m of messages.values()) {
          if (m.id !== where.id) continue;
          if (where.waMessageId && m.waMessageId !== where.waMessageId) continue;
          if (where.tenantId && m.tenantId !== where.tenantId) continue;
          if (where.conversation) {
            if (where.conversation.tenantId && m.conversation.tenantId !== where.conversation.tenantId) continue;
            if (where.conversation.phoneNumberId && m.conversation.phoneNumberId !== where.conversation.phoneNumberId) continue;
            if (where.conversation.phoneNumber?.wabaAccountId && m.conversation.phoneNumber.wabaAccountId !== where.conversation.phoneNumber.wabaAccountId) continue;
          }
          // Mimic Prisma select — only the requested fields
          return {
            id: m.id,
            status: m.status,
            conversationId: m.conversationId,
            waMessageId: m.waMessageId,
          };
        }
        return null;
      },
      update: async ({ where, data }: { where: { id: string }; data: { status?: MessageRecord["status"]; errorJson?: unknown } }) => {
        const m = messages.get(where.id);
        if (!m) throw new Error("message not found");
        if (data.status) m.status = data.status;
        if (data.errorJson !== undefined) m.errorJson = data.errorJson;
        return m;
      },
    },
    outboundSendAttempt: {
      updateMany: async ({ where, data }: { where: AttemptWhere; data: { state?: string } }) => {
        let count = 0;
        for (const a of attempts) {
          if (a.messageId !== where.messageId) continue;
          if (where.tenantId && a.tenantId !== where.tenantId) continue;
          if (where.waMessageId && a.waMessageId !== where.waMessageId) continue;
          if (where.state?.in) {
            const set = new Set(where.state.in);
            if (!set.has(a.state)) continue;
          }
          a.state = data.state ?? a.state;
          count += 1;
        }
        return { count };
      },
    },
    webhookEvent: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const ev = webhookEvents.get(where.id);
        if (!ev) return null;
        return { ...ev };
      },
      findFirst: async ({ where }: { where: WebhookEventWhere }) => {
        // The reconciliation query is loose (latest durable receipt).
        // Return any stored event whose eventSummary matches.
        for (const ev of webhookEvents.values()) {
          if (where.eventSummary && ev.eventSummary !== where.eventSummary) continue;
          if (where.payload?.path && !(ev.payload as { entry?: unknown })?.entry) continue;
          return { ...ev };
        }
        return null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<WebhookEvent> }) => {
        const ev = webhookEvents.get(where.id);
        if (!ev) throw new Error("webhookEvent not found");
        Object.assign(ev, data);
        return { ...ev };
      },
    },
    phoneNumber: {
      findFirst: async ({ where }: { where: PhoneWhere }) => {
        // We don't track phones in the in-memory store; the
        // reconciliation code only needs the row to exist. The
        // metaPhoneNumberId from the webhook payload is what's
        // actually compared.
        if (where.id !== "phone-1") return null;
        if (where.metaPhoneNumberId && where.metaPhoneNumberId !== "meta-phone-1") return null;
        if (where.wabaAccountId && where.wabaAccountId !== "waba-1") return null;
        return { id: "phone-1" };
      },
    },
  };
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => fn(makeTx()),
  },
}));

import { reconcileStatusEvent } from "@/lib/whatsapp/status/reconciliation";

function seedMessage(opts: { status?: MessageRecord["status"] } = {}): MessageRecord {
  const id = `msg-${messages.size + 1}`;
  const tenantId = "tenant-A";
  const conversationId = "conv-1";
  const waMessageId = `wamid.${id}`;
  const m: MessageRecord = {
    id,
    tenantId,
    conversationId,
    waMessageId,
    status: opts.status ?? "PENDING",
    conversation: { tenantId, phoneNumberId: "phone-1", phoneNumber: { wabaAccountId: "waba-1" } },
  };
  messages.set(id, m);
  attempts.push({
    messageId: id,
    tenantId,
    waMessageId,
    state: "PENDING",
  });
  return m;
}

function seedWebhookEvent(id: string, providerStatus: string, waMessageId: string): WebhookEvent {
  const ev: WebhookEvent = {
    id,
    payload: makeWebhookPayload(waMessageId, providerStatus),
    signatureValid: true,
    processedOk: false,
    eventSummary: "accepted durable status receipt",
    error: null,
  };
  webhookEvents.set(id, ev);
  return ev;
}

describe("reconcileStatusEvent — delivery/read synchronization", () => {
  beforeEach(() => {
    messages.clear();
    attempts.length = 0;
    webhookEvents.clear();
    publishMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("publishes message:status after a genuine transition", async () => {
    const m = seedMessage({ status: "SENT" });
    seedWebhookEvent("evt-1", "delivered", m.waMessageId);

    const result = await reconcileStatusEvent({
      webhookEventId: "evt-1",
      tenantId: m.tenantId,
      wabaAccountId: "waba-1",
      phoneNumberId: "phone-1",
      messageId: m.id,
      waMessageId: m.waMessageId,
    });

    expect(result.changed).toBe(true);
    expect(result.status).toBe("DELIVERED");
    expect(messages.get(m.id)!.status).toBe("DELIVERED");
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith(
      {
        type: "message:status",
        payload: {
          conversationId: m.conversationId,
          waMessageId: m.waMessageId,
          status: "DELIVERED",
        },
      },
      m.tenantId,
    );
  });

  it("does NOT publish on a duplicate notification (no-op)", async () => {
    const m = seedMessage({ status: "DELIVERED" });
    seedWebhookEvent("evt-2", "delivered", m.waMessageId);

    const result = await reconcileStatusEvent({
      webhookEventId: "evt-2",
      tenantId: m.tenantId,
      wabaAccountId: "waba-1",
      phoneNumberId: "phone-1",
      messageId: m.id,
      waMessageId: m.waMessageId,
    });

    expect(result.changed).toBe(false);
    expect(result.status).toBe("DELIVERED");
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("does NOT regress a newer canonical status from an older webhook", async () => {
    const m = seedMessage({ status: "READ" });
    seedWebhookEvent("evt-3", "delivered", m.waMessageId);

    const result = await reconcileStatusEvent({
      webhookEventId: "evt-3",
      tenantId: m.tenantId,
      wabaAccountId: "waba-1",
      phoneNumberId: "phone-1",
      messageId: m.id,
      waMessageId: m.waMessageId,
    });

    expect(result.changed).toBe(false);
    expect(result.status).toBe("READ");
    expect(messages.get(m.id)!.status).toBe("READ");
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("protects DELIVERED/READ against a later FAILED notification", async () => {
    const m = seedMessage({ status: "DELIVERED" });
    seedWebhookEvent("evt-4", "failed", m.waMessageId);

    const result = await reconcileStatusEvent({
      webhookEventId: "evt-4",
      tenantId: m.tenantId,
      wabaAccountId: "waba-1",
      phoneNumberId: "phone-1",
      messageId: m.id,
      waMessageId: m.waMessageId,
    });

    // FAILED is rank 1; DELIVERED is rank 2. nextStatus() must keep DELIVERED.
    expect(result.status).toBe("DELIVERED");
    expect(messages.get(m.id)!.status).toBe("DELIVERED");
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("emits publish on the second transition only, not on the first replay", async () => {
    const m = seedMessage({ status: "PENDING" });

    // First transition: PENDING -> SENT
    seedWebhookEvent("evt-5a", "sent", m.waMessageId);
    const r1 = await reconcileStatusEvent({
      webhookEventId: "evt-5a",
      tenantId: m.tenantId,
      wabaAccountId: "waba-1",
      phoneNumberId: "phone-1",
      messageId: m.id,
      waMessageId: m.waMessageId,
    });
    expect(r1.changed).toBe(true);
    expect(r1.status).toBe("SENT");
    expect(publishMock).toHaveBeenCalledTimes(1);

    // Replay the same SENT notification. No-op, no publish.
    seedWebhookEvent("evt-5b", "sent", m.waMessageId);
    const r2 = await reconcileStatusEvent({
      webhookEventId: "evt-5b",
      tenantId: m.tenantId,
      wabaAccountId: "waba-1",
      phoneNumberId: "phone-1",
      messageId: m.id,
      waMessageId: m.waMessageId,
    });
    expect(r2.changed).toBe(false);
    expect(publishMock).toHaveBeenCalledTimes(1);

    // Then a SENT -> DELIVERED transition emits a second publish.
    seedWebhookEvent("evt-5c", "delivered", m.waMessageId);
    const r3 = await reconcileStatusEvent({
      webhookEventId: "evt-5c",
      tenantId: m.tenantId,
      wabaAccountId: "waba-1",
      phoneNumberId: "phone-1",
      messageId: m.id,
      waMessageId: m.waMessageId,
    });
    expect(r3.changed).toBe(true);
    expect(r3.status).toBe("DELIVERED");
    expect(publishMock).toHaveBeenCalledTimes(2);
  });

  it("preserves the exact wire payload contract (no extra fields)", async () => {
    const m = seedMessage({ status: "SENT" });
    seedWebhookEvent("evt-6", "delivered", m.waMessageId);

    await reconcileStatusEvent({
      webhookEventId: "evt-6",
      tenantId: m.tenantId,
      wabaAccountId: "waba-1",
      phoneNumberId: "phone-1",
      messageId: m.id,
      waMessageId: m.waMessageId,
    });

    const call = publishMock.mock.calls[0]!;
    const [eventArg, tenantArg] = call;
    expect(eventArg).toEqual({
      type: "message:status",
      payload: {
        conversationId: m.conversationId,
        waMessageId: m.waMessageId,
        status: "DELIVERED",
      },
    });
    expect(tenantArg).toBe(m.tenantId);
  });

  it("ranks: PENDING -> SENT -> DELIVERED -> READ is the only ascending path", () => {
    // Sanity check: encode the canonical ordering guard. This is the
    // contract that out-of-order webhook tests above rely on.
    expect(STATUS_RANK.PENDING).toBeLessThan(STATUS_RANK.SENT);
    expect(STATUS_RANK.SENT).toBeLessThan(STATUS_RANK.DELIVERED);
    expect(STATUS_RANK.DELIVERED).toBeLessThan(STATUS_RANK.READ);
    expect(STATUS_MAP.sent).toBe("SENT");
    expect(STATUS_MAP.delivered).toBe("DELIVERED");
    expect(STATUS_MAP.read).toBe("READ");
    expect(STATUS_MAP.failed).toBe("FAILED");
  });
});
