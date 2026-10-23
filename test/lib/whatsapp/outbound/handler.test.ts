/**
 * Tests for the outbound message handler.
 *
 * Strategy: mock @/lib/prisma (top-level prisma client) AND
 * @/lib/whatsapp/outbound/repository (the durable claim functions).
 * Use the real WhatsAppApiError class (via vi.importActual) so the
 * handler's instanceof check works.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OutboundMessageJobPayload } from "@/lib/queue";
import { createOutboundMessageJobPayload } from "@/lib/queue";

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

const graphFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/whatsapp/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/client")>(
    "@/lib/whatsapp/client"
  );
  return { ...actual, graphFetch };
});

// Mock the repository's claim functions. The prisma client is mocked at the
// top level for the message/conversation operations the handler does.
const repoMock = vi.hoisted(() => {
  let currentAttempt: {
    id: string;
    state: "PENDING" | "CLAIMED" | "SENT" | "FAILED" | "RETRYABLE" | "UNCERTAIN";
    messageId: string;
    tenantId: string;
    attemptCount: number;
    ownerId: string | null;
    claimExpiresAt: Date | null;
    metaRequestStartedAt: Date | null;
    waMessageId: string | null;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    lastMetaStatus: number | null;
    finishedAt: Date | null;
    autoRetryCount: number;
    nextEligibleRetryAt: Date | null;
    lastRetryAfterSec: number | null;
  } | null = null;

  return {
    getOrCreateOutboundAttempt: vi.fn(async (_tx, input) => {
      if (!currentAttempt) {
        currentAttempt = {
          id: "attempt_1",
          state: "PENDING",
          messageId: input.messageId,
          tenantId: input.tenantId,
          attemptCount: 0,
          ownerId: null,
          claimExpiresAt: null,
          metaRequestStartedAt: null,
          waMessageId: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          lastMetaStatus: null,
          finishedAt: null,
          autoRetryCount: 0,
          nextEligibleRetryAt: null,
          lastRetryAfterSec: null,
        };
      }
      return currentAttempt;
    }),
    claimOutboundAttempt: vi.fn(async (_tx, input) => {
      // Only PENDING or RETRYABLE may be claimed automatically.
      if (!currentAttempt) return { claimed: false, attempt: null, existingState: null };
      const now = input.now ?? new Date();
      const eligible = currentAttempt.state === "PENDING" || currentAttempt.state === "RETRYABLE";
      if (eligible) {
        currentAttempt = {
          ...currentAttempt,
          state: "CLAIMED",
          ownerId: input.ownerId,
          claimExpiresAt: new Date(now.getTime() + (input.leaseMs ?? 60_000)),
          attemptCount: currentAttempt.attemptCount + 1,
        };
        return { claimed: true, attempt: currentAttempt, existingState: "CLAIMED" as const };
      }
      return { claimed: false, attempt: currentAttempt, existingState: currentAttempt.state };
    }),
    markOutboundMetaRequestStarted: vi.fn(async (_tx, input) => {
      if (!currentAttempt || currentAttempt.state !== "CLAIMED" || currentAttempt.id !== input.attemptId) {
        return null;
      }
      currentAttempt = {
        ...currentAttempt,
        metaRequestStartedAt: currentAttempt.metaRequestStartedAt ?? new Date(),
      };
      return currentAttempt;
    }),
    markOutboundSent: vi.fn(async (_tx, input) => {
      if (!currentAttempt || currentAttempt.state !== "CLAIMED") {
        throw new Error("not in CLAIMED");
      }
      currentAttempt = {
        ...currentAttempt,
        state: "SENT",
        waMessageId: input.waMessageId,
        claimExpiresAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        finishedAt: new Date(),
        autoRetryCount: 0,
        nextEligibleRetryAt: null,
        lastRetryAfterSec: null,
      };
      return currentAttempt;
    }),
    markOutboundFailed: vi.fn(async (_tx, input) => {
      if (!currentAttempt || currentAttempt.state !== "CLAIMED") {
        throw new Error("not in CLAIMED");
      }
      currentAttempt = {
        ...currentAttempt,
        state: input.retryable ? "RETRYABLE" : "FAILED",
        claimExpiresAt: null,
        lastErrorCode: input.errorCode,
        lastErrorMessage: input.errorMessage,
        lastMetaStatus: input.metaStatus ?? null,
      };
      return currentAttempt;
    }),
    markOutboundUncertain: vi.fn(async (_tx, input) => {
      if (!currentAttempt || currentAttempt.state !== "CLAIMED") {
        throw new Error("not in CLAIMED");
      }
      currentAttempt = {
        ...currentAttempt,
        state: "UNCERTAIN",
        claimExpiresAt: null,
        lastErrorCode: input.errorCode,
        lastErrorMessage: input.errorMessage,
        lastMetaStatus: input.metaStatus ?? null,
        finishedAt: new Date(),
        autoRetryCount: 0,
        nextEligibleRetryAt: null,
        lastRetryAfterSec: null,
      };
      return currentAttempt;
    }),
    markOutboundAutoRetryScheduled: vi.fn(async (_tx, input) => {
      if (!currentAttempt || currentAttempt.state !== "RETRYABLE") {
        throw new Error("not in RETRYABLE");
      }
      currentAttempt = {
        ...currentAttempt,
        nextEligibleRetryAt: input.nextEligibleRetryAt,
        lastRetryAfterSec: input.retryAfterSeconds,
        autoRetryCount: input.autoRetryCount,
      };
      return currentAttempt;
    }),
    __state: {
      get: () => currentAttempt,
      set: (a: typeof currentAttempt) => { currentAttempt = a; },
      reset: () => { currentAttempt = null; },
    },
  };
});

vi.mock("@/lib/whatsapp/outbound/repository", () => repoMock);

const eventsMock = vi.hoisted(() => ({ addCanonicalEvent: vi.fn(async () => ({})) }));
vi.mock("@/lib/events", async () => {
  const actual = await vi.importActual<typeof import("@/lib/events")>("@/lib/events");
  return { ...actual, addCanonicalEvent: eventsMock.addCanonicalEvent };
});

const prismaStub = vi.hoisted(() => ({
  message: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  conversation: {
    update: vi.fn(),
  },
  $transaction: vi.fn(async (arg: unknown) => {
    if (typeof arg === "function") {
      return (arg as (tx: unknown) => Promise<unknown>)(prismaStub);
    }
    return arg;
  }),
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaStub }));

// ---------------------------------------------------------------------------
// Test subject
// ---------------------------------------------------------------------------

const { handleOutboundMessage, OutboundHandlerError } = await import("@/lib/whatsapp/outbound/handler");
const { WhatsAppApiError } = await import("@/lib/whatsapp/client");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT = "tenant_test";
const WABA = "waba_test";
const PHONE = "phone_test";
const CONV = "conv_test";
const MSG = "msg_test";
const WA_MSG_ID = "wamid.TestMessage123";

function makePayload(): OutboundMessageJobPayload {
  return createOutboundMessageJobPayload({
    tenantId: TENANT,
    wabaAccountId: WABA,
    phoneNumberId: PHONE,
    conversationId: CONV,
    messageId: MSG,
    producer: "integration-test",
  });
}

function mockMessageRow(overrides: {
  status?: string;
  type?: string;
  tenantId?: string;
  waMessageId?: string | null;
  attemptState?: string;
} = {}) {
  return {
    id: MSG,
    tenantId: overrides.tenantId ?? TENANT,
    conversationId: CONV,
    direction: "OUT" as const,
    type: overrides.type ?? "TEXT",
    status: overrides.status ?? "PENDING",
    waMessageId: overrides.waMessageId ?? null,
    text: "Hello world",
    caption: null,
    mediaPath: null,
    mediaMime: null,
    mediaFilename: null,
    payload: null,
    templateId: null,
    errorJson: null,
    sentById: null,
    timestamp: new Date(),
    attempts: overrides.attemptState ? [{ state: overrides.attemptState }] : [],
    conversation: {
      id: CONV,
      contactId: "contact_test",
      status: "CLOSED",
      contact: { waId: "919876543210" },
      phoneNumber: {
        id: PHONE,
        wabaAccount: { id: WABA, tenantId: TENANT, metaWabaId: WABA, name: null },
        metaPhoneNumberId: "111111111",
        displayPhone: null,
        verifiedName: null,
        accessTokenEnc: null,
        appSecret: null,
        apiVersion: "v21.0",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleOutboundMessage", () => {
  beforeEach(() => {
    repoMock.__state.reset();
    vi.clearAllMocks();
    prismaStub.message.findUnique.mockResolvedValue(mockMessageRow());
    prismaStub.message.update.mockResolvedValue(mockMessageRow({ status: "SENT", waMessageId: WA_MSG_ID }));
    prismaStub.conversation.update.mockResolvedValue({ id: CONV, contactId: "contact_test", status: "OPEN" } as never);
    graphFetch.mockResolvedValue({ messages: [{ id: WA_MSG_ID }] });
  });

  describe("success", () => {
    it("calls Meta, updates message to SENT, marks attempt SENT", async () => {
      const result = await handleOutboundMessage(makePayload());

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.waMessageId).toBe(WA_MSG_ID);
        expect(result.attemptId).toBe("attempt_1");
      }
      expect(graphFetch).toHaveBeenCalledOnce();
      expect(prismaStub.message.update).toHaveBeenCalledWith({
        where: { id: MSG },
        data: { status: "SENT", waMessageId: WA_MSG_ID },
      });
      expect(repoMock.markOutboundSent).toHaveBeenCalledOnce();
      expect(repoMock.__state.get()?.state).toBe("SENT");
    });

    it("updates conversation lastMessageAt on success", async () => {
      await handleOutboundMessage(makePayload());

      expect(prismaStub.conversation.update).toHaveBeenCalledWith({
        where: { id: CONV },
        data: expect.objectContaining({ lastMessageAt: expect.any(Date) }),
      });
    });
  });

  describe("terminal-state idempotency", () => {
    it("skips when message is already SENT (no graphFetch call)", async () => {
      prismaStub.message.findUnique.mockResolvedValue(
        mockMessageRow({ status: "SENT", waMessageId: WA_MSG_ID })
      );

      const result = await handleOutboundMessage(makePayload());

      expect(result.status).toBe("skipped");
      expect((result as { reason: string }).reason).toBe("ALREADY_SENT");
      expect(graphFetch).not.toHaveBeenCalled();
    });

    it("skips when message is already FAILED (no graphFetch call)", async () => {
      prismaStub.message.findUnique.mockResolvedValue(
        mockMessageRow({ status: "FAILED" })
      );

      const result = await handleOutboundMessage(makePayload());

      expect(result.status).toBe("skipped");
      expect((result as { reason: string }).reason).toBe("ALREADY_FAILED");
      expect(graphFetch).not.toHaveBeenCalled();
    });

    it("retries when message is FAILED but its attempt is RETRYABLE", async () => {
      prismaStub.message.findUnique.mockResolvedValue(
        mockMessageRow({ status: "FAILED", attemptState: "RETRYABLE" })
      );

      const result = await handleOutboundMessage(makePayload());

      expect(result.status).toBe("success");
      expect(graphFetch).toHaveBeenCalledOnce();
    });
  });

  describe("ownership verification", () => {
    it("throws NOT_FOUND when message does not exist", async () => {
      prismaStub.message.findUnique.mockResolvedValue(null);

      await expect(handleOutboundMessage(makePayload())).rejects.toMatchObject({
        name: "OutboundHandlerError",
        code: "NOT_FOUND",
      });
    });

    it("throws when tenantId does not match", async () => {
      prismaStub.message.findUnique.mockResolvedValue(
        mockMessageRow({ tenantId: "other_tenant" })
      );

      await expect(handleOutboundMessage(makePayload())).rejects.toMatchObject({
        name: "OutboundHandlerError",
        code: "CLIENT_ERROR",
      });
      expect(graphFetch).not.toHaveBeenCalled();
    });

    it("throws when WABA account does not match", async () => {
      prismaStub.message.findUnique.mockResolvedValue({
        ...mockMessageRow(),
        conversation: {
          ...mockMessageRow().conversation,
          phoneNumber: {
            ...mockMessageRow().conversation.phoneNumber,
            wabaAccount: { id: "other_waba", tenantId: TENANT, metaWabaId: "other_waba", name: null },
          },
        },
      });

      await expect(handleOutboundMessage(makePayload())).rejects.toMatchObject({
        name: "OutboundHandlerError",
        code: "CLIENT_ERROR",
      });
    });
  });

  describe("certain failures → message FAILED", () => {
    it("marks message FAILED on 401 auth error", async () => {
      graphFetch.mockRejectedValueOnce(new WhatsAppApiError(401, "Unauthorized"));

      const result = await handleOutboundMessage(makePayload());

      expect(result.status).toBe("failed");
      expect((result as { errorCode: string }).errorCode).toBe("AUTH_ERROR");
      expect(prismaStub.message.update).toHaveBeenCalledWith({
        where: { id: MSG },
        data: expect.objectContaining({ status: "FAILED" }),
      });
      expect(repoMock.markOutboundFailed).toHaveBeenCalledOnce();
      expect(repoMock.__state.get()?.state).toBe("FAILED");
      expect(repoMock.__state.get()?.lastErrorCode).toBe("AUTH_ERROR");
    });

    it("marks message FAILED on 403 auth error", async () => {
      graphFetch.mockRejectedValueOnce(new WhatsAppApiError(403, "Forbidden"));

      const result = await handleOutboundMessage(makePayload());

      expect(result.status).toBe("failed");
      expect((result as { errorCode: string }).errorCode).toBe("AUTH_ERROR");
    });

    it("marks message FAILED on 400 client error", async () => {
      graphFetch.mockRejectedValueOnce(new WhatsAppApiError(400, "Bad request"));

      const result = await handleOutboundMessage(makePayload());

      expect(result.status).toBe("failed");
      expect((result as { errorCode: string }).errorCode).toBe("CLIENT_ERROR");
    });
  });

  describe("uncertain responses → message stays PENDING, attempt UNCERTAIN", () => {
    it("leaves message PENDING on HTTP 5xx server error", async () => {
      graphFetch.mockRejectedValueOnce(new WhatsAppApiError(500, "Internal server error"));

      const result = await handleOutboundMessage(makePayload());

      expect(result.status).toBe("uncertain");
      expect((result as { errorCode: string }).errorCode).toBe("META_SERVER_ERROR");
      expect(repoMock.__state.get()?.state).toBe("UNCERTAIN");
    });

    it("leaves message PENDING when Meta returns 200 without message ID", async () => {
      graphFetch.mockResolvedValueOnce({ messages: [] });

      const result = await handleOutboundMessage(makePayload());

      expect(result.status).toBe("uncertain");
      expect((result as { errorCode: string }).errorCode).toBe("MISSING_MESSAGE_ID");
    });

    it("leaves message PENDING on network timeout", async () => {
      graphFetch.mockRejectedValueOnce(new Error("fetch failed: timeout"));

      const result = await handleOutboundMessage(makePayload());

      expect(result.status).toBe("uncertain");
      expect((result as { errorCode: string }).errorCode).toBe("TIMEOUT");
    });
  });

  describe("WA-OUTRETRY-01 — AUTO_RETRY responses (429 explicit reject)", () => {
    it("schedules auto-retry on HTTP 429 with reject; message stays PENDING, attempt RETRYABLE", async () => {
      const err = new WhatsAppApiError(429, "Too many requests", 4, undefined, undefined, undefined, undefined, 30);
      graphFetch.mockRejectedValueOnce(err);

      const result = await handleOutboundMessage(makePayload());

      expect(result.status).toBe("failed");
      expect((result as { retryable: boolean }).retryable).toBe(true);
      expect((result as { errorCode: string }).errorCode).toBe("META_RATE_LIMIT");
      // Message status must NOT be FAILED — the scheduler may still rescue it.
      const updateCall = prismaStub.message.update.mock.calls[0]?.[0] as { data: { status?: string; errorJson?: object } };
      expect(updateCall.data.status).toBeUndefined();
      expect(updateCall.data.errorJson).toMatchObject({ autoRetryScheduled: true });
      expect(repoMock.__state.get()?.state).toBe("RETRYABLE");
    });
  });

  describe("durable claim protection", () => {
    it("skips when the attempt is already CLAIMED (concurrent worker)", async () => {
      // Pre-seed an existing CLAIMED attempt.
      repoMock.__state.set({
        id: "attempt_other",
        state: "CLAIMED",
        messageId: MSG,
        tenantId: TENANT,
        attemptCount: 1,
        ownerId: "other-worker",
        claimExpiresAt: new Date(Date.now() + 30_000),
        metaRequestStartedAt: null,
        waMessageId: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastMetaStatus: null,
        finishedAt: null,
        autoRetryCount: 0,
        nextEligibleRetryAt: null,
        lastRetryAfterSec: null,
      });

      const result = await handleOutboundMessage(makePayload());

      expect(result.status).toBe("skipped");
      expect((result as { reason: string }).reason).toBe("ALREADY_CLAIMED");
      expect(graphFetch).not.toHaveBeenCalled();
    });

    it("skips when the attempt is in UNCERTAIN state (cannot auto-retry)", async () => {
      repoMock.__state.set({
        id: "attempt_uncertain",
        state: "UNCERTAIN",
        messageId: MSG,
        tenantId: TENANT,
        attemptCount: 1,
        ownerId: null,
        claimExpiresAt: null,
        metaRequestStartedAt: null,
        waMessageId: null,
        lastErrorCode: "TIMEOUT",
        lastErrorMessage: "previous timeout",
        lastMetaStatus: null,
        finishedAt: new Date(),
        autoRetryCount: 0,
        nextEligibleRetryAt: null,
        lastRetryAfterSec: null,
      });

      const result = await handleOutboundMessage(makePayload());

      expect(result.status).toBe("skipped");
      expect((result as { reason: string }).reason).toBe("ALREADY_UNCERTAIN");
      expect(graphFetch).not.toHaveBeenCalled();
    });

    it("does not re-claim an expired CLAIMED lease automatically", async () => {
      repoMock.__state.set({
        id: "attempt_old",
        state: "CLAIMED",
        messageId: MSG,
        tenantId: TENANT,
        attemptCount: 1,
        ownerId: "crashed-worker",
        claimExpiresAt: new Date(Date.now() - 5_000),
        metaRequestStartedAt: new Date(Date.now() - 10_000),
        waMessageId: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastMetaStatus: null,
        finishedAt: null,
        autoRetryCount: 0,
        nextEligibleRetryAt: null,
        lastRetryAfterSec: null,
      });

      const result = await handleOutboundMessage(makePayload());

      expect(graphFetch).not.toHaveBeenCalled();
      expect(repoMock.__state.get()?.state).toBe("CLAIMED");
      expect(result.status).toBe("skipped");
      expect((result as { reason: string }).reason).toBe("ALREADY_CLAIMED");
    });
  });

  describe("OutboundHandlerError", () => {
    it("has the correct name and properties", () => {
      const err = new OutboundHandlerError("NOT_FOUND", "Not found");
      expect(err.name).toBe("OutboundHandlerError");
      expect(err.code).toBe("NOT_FOUND");
      expect(err.message).toBe("Not found");
      expect(err instanceof Error).toBe(true);
    });
  });
});
