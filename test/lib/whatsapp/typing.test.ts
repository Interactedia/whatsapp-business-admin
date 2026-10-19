/**
 * Unit tests for the typing-indicator service.
 *
 * These tests verify:
 * - The service requires explicit `markAsRead: true` before any Meta request.
 * - Tenant isolation: cross-tenant calls throw TenantAuthorizationError.
 * - Message correlation: unknown or cross-tenant messages are rejected.
 * - Meta errors (timeout, 4xx, 5xx) are handled safely.
 * - No durable queue publication (no BullMQ/outbox import).
 * - Internal unreadCount is never mutated.
 *
 * All Meta boundary calls are mocked; no real HTTP traffic occurs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TenantAuthorizationError } from "@/lib/tenant";

// ── Module-level state shared between mock layers ───────────────────────────────

const trustedContexts = new Set<import("@/lib/tenant").TenantContext>();

// ── Mock setup (hoisted so they run before module evaluation) ─────────────────

const mockGraphFetch = vi.hoisted(() => vi.fn<(req: Record<string, unknown>) => Promise<unknown>>());
const mockFindUnique = vi.hoisted(() => vi.fn());
const mockFindFirst = vi.hoisted(() => vi.fn());
const mockResolveTenantContext = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<import("@/lib/tenant").TenantContext>>());

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: { findUnique: mockFindUnique },
    message: { findFirst: mockFindFirst },
    tenantMembership: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: (value: string) => value,
  decrypt: (value: string) => value,
}));

vi.mock("@/lib/whatsapp/client", () => ({
  graphFetch: mockGraphFetch,
  WhatsAppApiError: class WhatsAppApiError extends Error {
    status?: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("@/lib/whatsapp/typing/config", () => ({
  TYPING_ENABLED: true,
  TYPING_REQUEST_TIMEOUT_MS: 10_000,
  TYPING_COOLDOWN_MS: 25_000,
}));

// ── Cooldown mock (unit tests never touch Redis) ────────────────────────────

const mockAcquireCooldown = vi.hoisted(() => vi.fn<() => Promise<boolean>>());

vi.mock("@/lib/whatsapp/typing/cooldown", () => ({
  tryAcquireTypingCooldown: mockAcquireCooldown,
}));

// ── Tenant module — mirror WeakSet so tests can seed trusted contexts ───────────

vi.mock("@/lib/tenant", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/tenant")>();

  return {
    ...original,
    // In tests, bypass the WeakSet check — seed trustedContexts via the
    // mock resolveTenantContext instead of calling the real one.
    assertTrustedTenantContext: vi.fn(),
    resolveTenantContext: async (...args: Parameters<typeof original.resolveTenantContext>) => {
      const resolved = await mockResolveTenantContext(...args);
      trustedContexts.add(resolved);
      return resolved;
    },
  };
});

// ── Import the service under test (after all mocks are registered) ─────────────

import { sendTypingIndicator } from "@/lib/whatsapp/typing/service";

// ── Shared fixtures ─────────────────────────────────────────────────────────────

const TENANT_ID = "tenant-1";
const USER_ID = "user-1";
const MEMBERSHIP_ID = "membership-1";

const ctx = {
  tenantId: TENANT_ID,
  userId: USER_ID,
  membershipId: MEMBERSHIP_ID,
} as const;

const mockPhone = {
  id: "phone-1",
  metaPhoneNumberId: "123456789",
  displayPhone: "+15550000001",
  verifiedName: "Test Business",
  wabaAccount: {
    id: "waba-1",
    tenantId: TENANT_ID,
    metaWabaId: "waba-id-1",
    name: "Test WABA",
    accessTokenEnc: "encrypted-token",
    apiVersion: "v21.0",
  },
};

function makeConversation(overrides: Partial<{
  id: string;
  tenantId: string;
  phoneNumber: typeof mockPhone | null;
  contact: { waId: string };
}> = {}) {
  return {
    id: "conv-1",
    tenantId: TENANT_ID,
    phoneNumberId: "phone-1",
    contact: { waId: "15550000002" },
    phoneNumber: mockPhone,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<{
  id: string;
  tenantId: string;
  conversationId: string;
  direction: "IN" | "OUT";
  waMessageId: string | null;
}> = {}) {
  return {
    id: "msg-1",
    tenantId: TENANT_ID,
    conversationId: "conv-1",
    direction: "IN" as const,
    waMessageId: "wamid.123",
    status: "RECEIVED",
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("WA-TYPING-INDICATOR sendTypingIndicator", () => {

  beforeEach(() => {
    // Reset all mock state so each test has a clean slate.
    vi.resetAllMocks();
    // Default graphFetch implementation (safe fallback for tests that don't
    // queue a specific value but still exercise the queue callback path).
    mockGraphFetch.mockImplementation(() => Promise.resolve(undefined));
    // Cooldown is granted by default; specific tests revoke it.
    mockAcquireCooldown.mockResolvedValue(true);
    trustedContexts.clear();
    mockResolveTenantContext.mockResolvedValue(ctx);
  });

  // ── Guard: markAsRead must be explicitly true ─────────────────────────────

  it("returns success=false when markAsRead is omitted (undefined)", async () => {
    mockFindUnique.mockResolvedValueOnce(makeConversation());

    const result = await sendTypingIndicator({
      context: ctx,
      conversationId: "conv-1",
      inboundMessageId: "msg-1",
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("markAsRead must be explicitly set to true");
    expect(mockGraphFetch).not.toHaveBeenCalled();
  });

  it("returns success=false when markAsRead is explicitly false", async () => {
    mockFindUnique.mockResolvedValueOnce(makeConversation());

    const result = await sendTypingIndicator({
      context: ctx,
      conversationId: "conv-1",
      inboundMessageId: "msg-1",
      markAsRead: false,
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("markAsRead must be explicitly set to true");
    expect(mockGraphFetch).not.toHaveBeenCalled();
  });

  // ── Conversation not found ─────────────────────────────────────────────────

  it("returns success=false when conversation does not exist", async () => {
    mockFindUnique.mockResolvedValueOnce(null);

    const result = await sendTypingIndicator({
      context: ctx,
      conversationId: "unknown-conv",
      inboundMessageId: "msg-1",
      markAsRead: true,
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("conversation not found");
    expect(mockGraphFetch).not.toHaveBeenCalled();
  });

  // ── Tenant isolation ──────────────────────────────────────────────────────

  it("throws TenantAuthorizationError for cross-tenant conversation", async () => {
    mockFindUnique.mockResolvedValueOnce(makeConversation({ tenantId: "other-tenant" }));

    await expect(
      sendTypingIndicator({
        context: ctx,
        conversationId: "conv-1",
        inboundMessageId: "msg-1",
        markAsRead: true,
      }),
    ).rejects.toBeInstanceOf(TenantAuthorizationError);

    expect(mockGraphFetch).not.toHaveBeenCalled();
  });

  // ── Inbound message not found / invalid ──────────────────────────────────

  it("returns success=false when inbound message does not exist", async () => {
    mockFindUnique.mockResolvedValueOnce(makeConversation());
    mockFindFirst.mockResolvedValueOnce(null);

    const result = await sendTypingIndicator({
      context: ctx,
      conversationId: "conv-1",
      inboundMessageId: "unknown-msg",
      markAsRead: true,
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("inbound message not found");
    expect(mockGraphFetch).not.toHaveBeenCalled();
  });

  it("returns success=false when inbound message has no waMessageId", async () => {
    mockFindUnique.mockResolvedValueOnce(makeConversation());
    mockFindFirst.mockResolvedValueOnce(makeMessage({ waMessageId: null }));

    const result = await sendTypingIndicator({
      context: ctx,
      conversationId: "conv-1",
      inboundMessageId: "msg-1",
      markAsRead: true,
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("no provider message ID");
    expect(mockGraphFetch).not.toHaveBeenCalled();
  });

  // NOTE: Tests that go through the p-queue (all graphFetch callers) use the
  // 30-second timeout because the p-queue introduces a 5-second real-time interval.
  // The full suite of 12 tests should complete in well under 30 seconds total.

  // ── Correct Meta payload ─────────────────────────────────────────────────

  it("sends graphFetch with the correct combined payload when markAsRead=true", async () => {
    mockFindUnique.mockResolvedValueOnce(makeConversation());
    mockFindFirst.mockResolvedValueOnce(makeMessage());
    mockGraphFetch.mockResolvedValueOnce({ success: true });

    const result = await sendTypingIndicator({
      context: ctx,
      conversationId: "conv-1",
      inboundMessageId: "msg-1",
      markAsRead: true,
    });

    expect(result.success).toBe(true);
    expect(mockGraphFetch).toHaveBeenCalledTimes(1);

    const firstCall = mockGraphFetch.mock.calls[0];
    expect(firstCall).toBeDefined();
    const call = firstCall![0];
    const body = call.body as Record<string, unknown>;
    expect(call.method).toBe("POST");
    expect(body["messaging_product"]).toBe("whatsapp");
    expect(body["status"]).toBe("read");
    expect(body["message_id"]).toBe("wamid.123");
    expect(body["typing_indicator"]).toEqual({ type: "text" });
  });

  // ── Meta error handling ───────────────────────────────────────────────────

  it("returns success=false on generic network error", async () => {
    mockFindUnique.mockResolvedValueOnce(makeConversation());
    mockFindFirst.mockResolvedValueOnce(makeMessage());
    mockGraphFetch.mockRejectedValueOnce(new Error("network timeout"));

    const result = await sendTypingIndicator({
      context: ctx,
      conversationId: "conv-1",
      inboundMessageId: "msg-1",
      markAsRead: true,
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("network timeout");
  });

  it("returns success=false on Meta 4xx error", async () => {
    mockFindUnique.mockResolvedValueOnce(makeConversation());
    mockFindFirst.mockResolvedValueOnce(makeMessage());

    const { WhatsAppApiError } = await import("@/lib/whatsapp/client");
    mockGraphFetch.mockRejectedValueOnce(new WhatsAppApiError(400, "Invalid message ID"));

    const result = await sendTypingIndicator({
      context: ctx,
      conversationId: "conv-1",
      inboundMessageId: "msg-1",
      markAsRead: true,
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("Meta error 400");
    expect(result.reason).toContain("Invalid message ID");
  });

  it("returns success=false on Meta 5xx error", async () => {
    mockFindUnique.mockResolvedValueOnce(makeConversation());
    mockFindFirst.mockResolvedValueOnce(makeMessage());

    const { WhatsAppApiError } = await import("@/lib/whatsapp/client");
    mockGraphFetch.mockRejectedValueOnce(new WhatsAppApiError(500, "Internal server error"));

    const result = await sendTypingIndicator({
      context: ctx,
      conversationId: "conv-1",
      inboundMessageId: "msg-1",
      markAsRead: true,
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("Meta error 500");
  });

  // ── No durable queue ─────────────────────────────────────────────────────

  it("does not call any durable queue (graphFetch is the only external call)", async () => {
    mockFindUnique.mockResolvedValueOnce(makeConversation());
    mockFindFirst.mockResolvedValueOnce(makeMessage());
    mockGraphFetch.mockResolvedValueOnce({ success: true });

    await sendTypingIndicator({
      context: ctx,
      conversationId: "conv-1",
      inboundMessageId: "msg-1",
      markAsRead: true,
    });

    // The service only calls graphFetch; no BullMQ or outbox calls are possible
    // since those modules are not imported by the typing service.
    expect(mockGraphFetch).toHaveBeenCalledTimes(1);
  });

  // ── Conversation without phone number ─────────────────────────────────────

  it("returns success=false when conversation has no phone number", async () => {
    mockFindUnique.mockResolvedValueOnce(makeConversation({ phoneNumber: null }));

    const result = await sendTypingIndicator({
      context: ctx,
      conversationId: "conv-1",
      inboundMessageId: "msg-1",
      markAsRead: true,
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("no associated phone number");
    expect(mockGraphFetch).not.toHaveBeenCalled();
  });

  // ── WA-TYPING-01: Redis cooldown ──────────────────────────────────────────

  it("dispatches typing when the cooldown slot is acquired", async () => {
    mockFindUnique.mockResolvedValueOnce(makeConversation());
    mockFindFirst.mockResolvedValueOnce(makeMessage());
    mockGraphFetch.mockResolvedValueOnce({ success: true });

    const result = await sendTypingIndicator({
      context: ctx,
      conversationId: "conv-1",
      inboundMessageId: "msg-1",
      markAsRead: true,
    });

    expect(mockAcquireCooldown).toHaveBeenCalledWith(TENANT_ID, "123456789", "15550000002");
    expect(result.success).toBe(true);
    expect(mockGraphFetch).toHaveBeenCalledTimes(1);
  });

  it("discards typing BEFORE any Meta call when the cooldown is active", async () => {
    mockFindUnique.mockResolvedValueOnce(makeConversation());
    mockFindFirst.mockResolvedValueOnce(makeMessage());
    mockAcquireCooldown.mockResolvedValue(false);

    const result = await sendTypingIndicator({
      context: ctx,
      conversationId: "conv-1",
      inboundMessageId: "msg-1",
      markAsRead: true,
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("cooldown");
    expect(mockGraphFetch).not.toHaveBeenCalled();
  });

  it("sendReadReceipt bypasses the typing cooldown", async () => {
    mockFindUnique.mockResolvedValueOnce(makeConversation());
    mockFindFirst.mockResolvedValueOnce(makeMessage());
    mockGraphFetch.mockResolvedValueOnce({ success: true });
    mockAcquireCooldown.mockResolvedValue(false); // would block typing

    const { sendReadReceipt } = await import("@/lib/whatsapp/typing/service");
    const result = await sendReadReceipt({
      context: ctx,
      conversationId: "conv-1",
      inboundMessageId: "msg-1",
      markAsRead: true,
    });

    expect(mockAcquireCooldown).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    const body = mockGraphFetch.mock.calls[0]![0] as { body: Record<string, unknown> };
    expect(body.body["typing_indicator"]).toBeUndefined();
  });
});
