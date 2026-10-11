import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleBroadcastDispatch, BroadcastHandlerError } from "@/lib/whatsapp/broadcast/handler";
import type { BroadcastPrisma } from "@/lib/whatsapp/broadcast/repository";
import type { BroadcastDispatchJobPayload } from "@/lib/queue";
import { WhatsAppApiError } from "@/lib/whatsapp/client";

vi.mock("@/lib/settings", () => ({
  getWabaConfig: vi.fn().mockResolvedValue({
    phoneNumberId: "phone_123",
    accessToken: "token_abc",
  }),
}));

vi.mock("@/lib/whatsapp/send", () => ({
  ensureConversation: vi.fn().mockResolvedValue({
    conversation: { id: "conv_1", tenantId: "t1" },
  }),
}));

vi.mock("@/lib/whatsapp/template-service", () => ({
  templateExampleComponents: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/whatsapp/flow-launch", () => ({
  prepareTemplateFlowLaunch: vi.fn().mockResolvedValue(undefined),
  finishPreparedFlowLaunch: vi.fn().mockResolvedValue(undefined),
}));

describe("broadcast worker handler", () => {
  const basePayload: BroadcastDispatchJobPayload = {
    type: "broadcast.dispatch",
    version: 1,
    producer: "queue-producer",
    enqueuedAt: new Date().toISOString(),
    ref: {
      tenantId: "t1",
      wabaAccountId: "waba1",
      broadcastId: "b1",
      broadcastRecipientId: "r1",
      contactId: "c1",
    },
  };

  const validBroadcast = {
    id: "b1",
    tenantId: "t1",
    status: "RUNNING",
    templateId: "tpl1",
    template: {
      id: "tpl1",
      tenantId: "t1",
      status: "APPROVED",
      name: "promo",
      language: "en",
    },
  };

  const validRecipient = {
    id: "r1",
    broadcastId: "b1",
    contactId: "c1",
    status: "PENDING",
    contact: { id: "c1", waId: "1234567890", tenantId: "t1" },
    broadcast: validBroadcast,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails closed on tenant mismatch in broadcast", async () => {
    const mockDb = {
      broadcast: {
        findUnique: vi.fn().mockResolvedValue({
          ...validBroadcast,
          tenantId: "foreign_tenant",
        }),
      },
    } as unknown as BroadcastPrisma;

    await expect(handleBroadcastDispatch(basePayload, { db: mockDb })).rejects.toThrow(
      BroadcastHandlerError
    );
  });

  it("skips execution cleanly if campaign is cancelled", async () => {
    const mockDb = {
      broadcast: {
        findUnique: vi.fn().mockResolvedValue({
          ...validBroadcast,
          status: "CANCELLED",
        }),
      },
    } as unknown as BroadcastPrisma;

    const res = await handleBroadcastDispatch(basePayload, { db: mockDb });
    expect(res).toEqual({
      status: "cancelled",
      broadcastId: "b1",
      broadcastRecipientId: "r1",
      reason: "CAMPAIGN_CANCELLED",
    });
  });

  it("skips execution if recipient is already SENT", async () => {
    const mockDb = {
      broadcast: {
        findUnique: vi.fn().mockResolvedValue(validBroadcast),
      },
      broadcastRecipient: {
        findUnique: vi.fn().mockResolvedValue({
          ...validRecipient,
          status: "SENT",
        }),
      },
    } as unknown as BroadcastPrisma;

    const res = await handleBroadcastDispatch(basePayload, { db: mockDb });
    expect(res).toEqual({
      status: "skipped",
      broadcastId: "b1",
      broadcastRecipientId: "r1",
      reason: "ALREADY_SENT",
    });
  });

  it("successfully marks recipient SENT upon 200 response from Meta", async () => {
    const fakeGraphFetch = vi.fn().mockResolvedValue({
      messages: [{ id: "wamid.broadcast_success" }],
    });

    const mockDb = {
      broadcast: {
        findUnique: vi.fn().mockResolvedValue(validBroadcast),
        update: vi.fn().mockResolvedValue({}),
      },
      broadcastRecipient: {
        findUnique: vi.fn().mockResolvedValue(validRecipient),
        update: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(0),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "msg_1" }),
        update: vi.fn().mockResolvedValue({}),
      },
      conversation: {
        update: vi.fn().mockResolvedValue({}),
      },
      outboundSendAttempt: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      $transaction: vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb)),
      $queryRaw: vi.fn().mockImplementation(async (strings: TemplateStringsArray | string[]) => {
        const raw = String(strings);
        if (raw.includes("UPDATE \"OutboundSendAttempt\"")) {
          return [{
            id: "att_1",
            messageId: "msg_1",
            tenantId: "t1",
            state: "CLAIMED",
            attemptCount: 1,
          }];
        }
        return [];
      }),
    } as unknown as BroadcastPrisma;

    const res = await handleBroadcastDispatch(basePayload, {
      db: mockDb,
      graphFetch: fakeGraphFetch,
    });

    expect(res.status).toBe("sent");
    if (res.status === "sent") {
      expect(res.waMessageId).toBe("wamid.broadcast_success");
    }
    expect(fakeGraphFetch).toHaveBeenCalledTimes(1);
  });

  it("classifies 500 error as UNCERTAIN without throwing or retrying blindly", async () => {
    const fakeGraphFetch = vi.fn().mockRejectedValue(new WhatsAppApiError(500, "Internal Server Error"));

    const mockDb = {
      broadcast: {
        findUnique: vi.fn().mockResolvedValue(validBroadcast),
        update: vi.fn().mockResolvedValue({}),
      },
      broadcastRecipient: {
        findUnique: vi.fn().mockResolvedValue(validRecipient),
        update: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(1),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "msg_1" }),
        update: vi.fn().mockResolvedValue({}),
      },
      outboundSendAttempt: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      $transaction: vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb)),
      $queryRaw: vi.fn().mockImplementation(async (strings: TemplateStringsArray | string[]) => {
        const raw = String(strings);
        if (raw.includes("UPDATE \"OutboundSendAttempt\"")) {
          return [{
            id: "att_1",
            messageId: "msg_1",
            tenantId: "t1",
            state: "CLAIMED",
            attemptCount: 1,
          }];
        }
        return [];
      }),
    } as unknown as BroadcastPrisma;

    const res = await handleBroadcastDispatch(basePayload, {
      db: mockDb,
      graphFetch: fakeGraphFetch,
    });

    expect(res.status).toBe("uncertain");
    if (res.status === "uncertain") {
      expect(res.errorCode).toBe("META_SERVER_ERROR");
    }
  });

  it("classifies 400 error as FAILED (certain failure)", async () => {
    const fakeGraphFetch = vi.fn().mockRejectedValue(new WhatsAppApiError(400, "Invalid parameter"));

    const mockDb = {
      broadcast: {
        findUnique: vi.fn().mockResolvedValue(validBroadcast),
        update: vi.fn().mockResolvedValue({}),
      },
      broadcastRecipient: {
        findUnique: vi.fn().mockResolvedValue(validRecipient),
        update: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(0),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "msg_1" }),
        update: vi.fn().mockResolvedValue({}),
      },
      outboundSendAttempt: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      $transaction: vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb)),
      $queryRaw: vi.fn().mockImplementation(async (strings: TemplateStringsArray | string[]) => {
        const raw = String(strings);
        if (raw.includes("UPDATE \"OutboundSendAttempt\"")) {
          return [{
            id: "att_1",
            messageId: "msg_1",
            tenantId: "t1",
            state: "CLAIMED",
            attemptCount: 1,
          }];
        }
        return [];
      }),
    } as unknown as BroadcastPrisma;

    const res = await handleBroadcastDispatch(basePayload, {
      db: mockDb,
      graphFetch: fakeGraphFetch,
    });

    expect(res.status).toBe("failed");
    if (res.status === "failed") {
      expect(res.errorCode).toBe("CLIENT_ERROR");
    }
  });
});
