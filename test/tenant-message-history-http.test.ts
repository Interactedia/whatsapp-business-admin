import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TenantAuthorizationError, type TenantContext } from "@/lib/tenant";

let mockAuthValue: { user: { id: string; role: string } } | null = null;
let mockResolveResult: TenantContext | Error = new TenantAuthorizationError();
let mockFindConversationResult: unknown = null;
let mockListConversationMessagesResult: unknown[] = [];

function mockAuth(session: typeof mockAuthValue) {
  mockAuthValue = session;
}

function mockResolveTenantContext(result: typeof mockResolveResult) {
  mockResolveResult = result;
}

function mockFindConversation(result: unknown) {
  mockFindConversationResult = result;
}

function mockListConversationMessages(result: unknown[]) {
  mockListConversationMessagesResult = result;
}

const resolveTenantContextSpy = vi.hoisted(() => vi.fn());
const findConversationSpy = vi.hoisted(() => vi.fn());
const listConversationMessagesSpy = vi.hoisted(() => vi.fn());
const resolveTemplateContentsSpy = vi.hoisted(() => vi.fn().mockResolvedValue(new Map()));

const hoistedMockAuth = vi.hoisted(() => () => Promise.resolve(mockAuthValue));
const hoistedMockResolve = vi.hoisted(() => {
  return (...args: unknown[]) => {
    resolveTenantContextSpy(...args);
    if (mockResolveResult instanceof Error) throw mockResolveResult;
    return Promise.resolve(mockResolveResult);
  };
});
const hoistedMockFindConversation = vi.hoisted(() => {
  return (...args: unknown[]) => {
    findConversationSpy(...args);
    if (mockFindConversationResult instanceof Error) throw mockFindConversationResult;
    return Promise.resolve(mockFindConversationResult);
  };
});
const hoistedMockListConversationMessages = vi.hoisted(() => {
  return (...args: unknown[]) => {
    listConversationMessagesSpy(...args);
    return Promise.resolve(mockListConversationMessagesResult);
  };
});

vi.mock("@/auth", () => ({ auth: hoistedMockAuth }));
vi.mock("@/lib/tenant", () => ({
  resolveTenantContext: hoistedMockResolve,
  TenantAuthorizationError: class TenantAuthorizationError extends Error {
    constructor() { super("Tenant access denied"); this.name = "TenantAuthorizationError"; }
  },
}));
vi.mock("@/lib/tenant/repository", () => ({
  tenantMessagingRepository: {
    findConversation: hoistedMockFindConversation,
    listConversationMessages: hoistedMockListConversationMessages,
  },
}));
vi.mock("@/lib/whatsapp/template-history", () => ({
  resolveTemplateContents: resolveTemplateContentsSpy,
}));
vi.mock("@/lib/whatsapp/send", () => ({
  enqueueOutboundMessage: vi.fn().mockResolvedValue({ id: "msg-sent-1", status: "PENDING", waMessageId: null }),
  isWithinSessionWindow: vi.fn().mockReturnValue(true),
}));

// Mock prisma for flow submissions and mark-read.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    flowSubmission: { findMany: vi.fn().mockResolvedValue([]) },
    conversation: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  },
}));

const mockTenantContext: TenantContext = {
  tenantId: "tenant-1",
  userId: "user-1",
  membershipId: "membership-1",
};

const mockPrisma = vi.mocked(await import("@/lib/prisma")).prisma;

import { GET, POST as postMessage } from "@/app/api/tenants/[tenantId]/conversations/[conversationId]/messages/route";

function makeRequest(tenantId: string, conversationId: string, qs = "") {
  return new Request(
    `https://example.test/api/tenants/${tenantId}/conversations/${conversationId}/messages${qs ? `?${qs}` : ""}`,
    { method: "GET" },
  );
}

function makeParams(tenantId: string, conversationId: string) {
  return { params: Promise.resolve({ tenantId, conversationId }) };
}

function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "conversation-1",
    tenantId: "tenant-1",
    contactId: "contact-1",
    contact: { id: "contact-1", waId: "919812345678", name: "John", profileName: "John D", tenantId: "tenant-1" },
    status: "OPEN",
    unreadCount: 2,
    lastMessageAt: new Date("2026-01-02"),
    lastInboundAt: new Date("2026-01-01"),
    lastPreview: "hello",
    assignedUserId: "agent-1",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-03"),
    ...overrides,
  };
}

function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "message-1",
    conversationId: "conversation-1",
    tenantId: "tenant-1",
    direction: "IN",
    type: "TEXT",
    status: "RECEIVED",
    text: "Hello",
    caption: null,
    mediaPath: null,
    mediaMime: null,
    mediaFilename: null,
    timestamp: new Date("2026-01-01T12:00:00Z"),
    waMessageId: null,
    payload: null,
    ...overrides,
  };
}

function flowSubmissionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "flow-sub-1",
    launchId: "launch-1",
    waMessageId: null,
    responseEnc: null,
    responseKeys: [],
    purgedAt: null,
    completedAt: new Date("2026-01-01T13:00:00Z"),
    createdAt: new Date("2026-01-01T12:00:00Z"),
    launch: {
      id: "launch-1",
      status: "COMPLETED",
      conversationId: "conversation-1",
      flow: { id: "flow-1", name: "Survey", sensitiveFields: [] },
    },
    ...overrides,
  };
}

describe("GET /api/tenants/:tenantId/conversations/:conversationId/messages", () => {
  afterEach(() => {
    mockAuth(null);
    mockResolveTenantContext(new TenantAuthorizationError());
    mockFindConversation(null);
    mockListConversationMessages([]);
    vi.mocked(mockPrisma.flowSubmission.findMany).mockResolvedValue([]);
    vi.mocked(mockPrisma.conversation.updateMany).mockResolvedValue({ count: 0 });
    resolveTemplateContentsSpy.mockReset();
    resolveTemplateContentsSpy.mockResolvedValue(new Map());
    vi.clearAllMocks();
  });

  describe("authentication", () => {
    it("returns 401 when no session", async () => {
      mockAuth(null);
      const response = await GET(makeRequest("tenant-1", "conversation-1"), makeParams("tenant-1", "conversation-1"));
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe("Unauthorized");
    });
  });

  describe("tenant authorization", () => {
    it("returns 403 when membership not found", async () => {
      mockAuth({ user: { id: "user-1", role: "AGENT" } });
      mockResolveTenantContext(new TenantAuthorizationError());
      const response = await GET(makeRequest("tenant-1", "conversation-1"), makeParams("tenant-1", "conversation-1"));
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("Tenant access denied");
    });

    it("returns 403 for ADMIN without membership", async () => {
      mockAuth({ user: { id: "admin-user", role: "ADMIN" } });
      mockResolveTenantContext(new TenantAuthorizationError());
      const response = await GET(makeRequest("tenant-1", "conversation-1"), makeParams("tenant-1", "conversation-1"));
      expect(response.status).toBe(403);
    });
  });

  describe("conversation ownership", () => {
    it("returns 404 for unknown conversation", async () => {
      mockAuth({ user: { id: "user-1", role: "AGENT" } });
      mockResolveTenantContext(mockTenantContext);
      mockFindConversation(null);
      const response = await GET(makeRequest("tenant-1", "conversation-1"), makeParams("tenant-1", "conversation-1"));
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("Conversation not found");
    });

    it("returns 404 for cross-tenant conversation", async () => {
      mockAuth({ user: { id: "user-1", role: "AGENT" } });
      mockResolveTenantContext(mockTenantContext);
      mockFindConversation(new TenantAuthorizationError()); // findConversation throws for cross-tenant
      const response = await GET(makeRequest("tenant-2", "conversation-other"), makeParams("tenant-2", "conversation-other"));
      expect(response.status).toBe(404);
    });

    it("returns 404 when contact ownership does not match tenant", async () => {
      mockAuth({ user: { id: "user-1", role: "AGENT" } });
      mockResolveTenantContext(mockTenantContext);
      // Repository returns null when the related contact belongs to another tenant.
      mockFindConversation(null);
      const response = await GET(makeRequest("tenant-1", "conversation-1"), makeParams("tenant-1", "conversation-1"));
      expect(response.status).toBe(404);
    });

    it("returns 404 when conversation tenantId is null", async () => {
      mockAuth({ user: { id: "user-1", role: "AGENT" } });
      mockResolveTenantContext(mockTenantContext);
      mockFindConversation(new TenantAuthorizationError()); // repository rejects null tenantId
      const response = await GET(makeRequest("tenant-1", "conversation-1"), makeParams("tenant-1", "conversation-1"));
      expect(response.status).toBe(404);
    });
  });

  describe("authorized access", () => {
    beforeEach(() => {
      mockAuth({ user: { id: "user-1", role: "AGENT" } });
      mockResolveTenantContext(mockTenantContext);
      mockFindConversation(conversationRow());
      mockListConversationMessages([messageRow()]);
    });

    it("returns 200 with conversation, messages, and flow submissions", async () => {
      vi.mocked(mockPrisma.flowSubmission.findMany).mockResolvedValue([flowSubmissionRow()] as never);
      const response = await GET(makeRequest("tenant-1", "conversation-1"), makeParams("tenant-1", "conversation-1"));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("conversation");
      expect(body).toHaveProperty("messages");
      expect(body).toHaveProperty("flowSubmissions");
    });

    it("exposes allowlisted conversation fields only", async () => {
      const response = await GET(makeRequest("tenant-1", "conversation-1"), makeParams("tenant-1", "conversation-1"));
      const body = await response.json();
      expect(body.conversation).toHaveProperty("id");
      expect(body.conversation).toHaveProperty("contact");
      expect(body.conversation).toHaveProperty("windowOpen");
      expect(body.conversation).not.toHaveProperty("tenantId");
      expect(body.conversation).not.toHaveProperty("secret");
      expect(body.conversation).not.toHaveProperty("assignedUserId");
    });

    it("marks conversation read when unreadCount > 0", async () => {
      const response = await GET(makeRequest("tenant-1", "conversation-1"), makeParams("tenant-1", "conversation-1"));
      expect(response.status).toBe(200);
      expect(mockPrisma.conversation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "conversation-1", tenantId: "tenant-1" }, data: { unreadCount: 0 } })
      );
    });

    it("does not mark read when unreadCount is 0", async () => {
      mockFindConversation(conversationRow({ unreadCount: 0 }));
      const response = await GET(makeRequest("tenant-1", "conversation-1"), makeParams("tenant-1", "conversation-1"));
      expect(response.status).toBe(200);
      expect(mockPrisma.conversation.updateMany).not.toHaveBeenCalled();
    });

    it("calls listConversationMessages with tenant-scoped context and conversationId", async () => {
      const response = await GET(makeRequest("tenant-1", "conversation-1"), makeParams("tenant-1", "conversation-1"));
      expect(response.status).toBe(200);
      expect(listConversationMessagesSpy).toHaveBeenCalledWith(mockTenantContext, "conversation-1", expect.any(Object));
    });

    it("passes pagination params to listConversationMessages", async () => {
      const response = await GET(makeRequest("tenant-1", "conversation-1", "take=50&cursor=msg-123"), makeParams("tenant-1", "conversation-1"));
      expect(response.status).toBe(200);
      expect(listConversationMessagesSpy).toHaveBeenCalledWith(mockTenantContext, "conversation-1", expect.objectContaining({ take: 50, cursor: "msg-123" }));
    });

    it("clamps take to maximum 200", async () => {
      const response = await GET(makeRequest("tenant-1", "conversation-1", "take=500"), makeParams("tenant-1", "conversation-1"));
      expect(response.status).toBe(200);
      expect(listConversationMessagesSpy).toHaveBeenCalledWith(mockTenantContext, "conversation-1", expect.objectContaining({ take: 200 }));
    });

    it("excludes foreign tenant messages through repository isolation", async () => {
      const crossTenantMsg = { ...messageRow(), tenantId: "tenant-2" };
      mockListConversationMessages([messageRow(), crossTenantMsg]);
      // The repository already filters; this tests the caller passes correct context.
      const response = await GET(makeRequest("tenant-1", "conversation-1"), makeParams("tenant-1", "conversation-1"));
      expect(response.status).toBe(200);
      expect(findConversationSpy).toHaveBeenCalledWith(mockTenantContext, "conversation-1");
    });

    it("resolves template contents for TEMPLATE-type messages", async () => {
      const tmplMsg = messageRow({ type: "TEMPLATE" });
      mockListConversationMessages([tmplMsg]);
      resolveTemplateContentsSpy.mockResolvedValue(new Map([["message-1", { body: "Hello {{1}}" }]]));
      const response = await GET(makeRequest("tenant-1", "conversation-1"), makeParams("tenant-1", "conversation-1"));
      expect(response.status).toBe(200);
      expect(resolveTemplateContentsSpy).toHaveBeenCalled();
    });

    it("excludes messages from other tenants via repository predicates", async () => {
      // Repository enforces tenantId on messages; test verifies correct context is passed.
      mockListConversationMessages([messageRow({ tenantId: "tenant-1" })]);
      const response = await GET(makeRequest("tenant-1", "conversation-1"), makeParams("tenant-1", "conversation-1"));
      expect(response.status).toBe(200);
      expect(listConversationMessagesSpy).toHaveBeenCalledWith(mockTenantContext, "conversation-1", expect.any(Object));
    });
  });

  describe("flow submissions scoping", () => {
    beforeEach(() => {
      mockAuth({ user: { id: "user-1", role: "AGENT" } });
      mockResolveTenantContext(mockTenantContext);
      mockFindConversation(conversationRow());
      mockListConversationMessages([]);
    });

    it("scopes flow submissions through conversation tenantId", async () => {
      const response = await GET(makeRequest("tenant-1", "conversation-1"), makeParams("tenant-1", "conversation-1"));
      expect(response.status).toBe(200);
      expect(mockPrisma.flowSubmission.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            launch: expect.objectContaining({
              conversationId: "conversation-1",
              conversation: { tenantId: "tenant-1", contact: { tenantId: "tenant-1" } },
            }),
          }),
        })
      );
    });

    it("returns flow submissions with allowlisted fields", async () => {
      vi.mocked(mockPrisma.flowSubmission.findMany).mockResolvedValue([flowSubmissionRow()]);
      const response = await GET(makeRequest("tenant-1", "conversation-1"), makeParams("tenant-1", "conversation-1"));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.flowSubmissions[0]).toHaveProperty("id");
      expect(body.flowSubmissions[0]).toHaveProperty("flow");
      expect(body.flowSubmissions[0]).toHaveProperty("response");
      expect(body.flowSubmissions[0].flow).toHaveProperty("name");
      expect(body.flowSubmissions[0]).not.toHaveProperty("responseEnc");
    });
  });

  describe("legacy GET removal", () => {
    it("legacy /api/conversations/[id]/messages POST is removed", async () => {
      const route = await import("@/app/api/conversations/[id]/messages/route");
      expect(route).not.toHaveProperty("GET");
      // POST removed — superseded by /api/tenants/:tenantId/conversations/:conversationId/messages
      expect(route).not.toHaveProperty("POST");
    });
  });

  describe("UI consumer migration", () => {
    it("inbox-client uses canonical tenant-scoped messages endpoint", async () => {
      const source = await import("node:fs").then((fs) =>
        fs.readFileSync("src/app/(app)/inbox/inbox-client.tsx", "utf-8"),
      );
      // Should use the new canonical endpoint with tenantId.
      expect(source).toMatch(/\/api\/tenants\/\${tenantId}\/conversations\/\${conversationId}\/messages/);
      // Should NOT use the legacy global endpoint for POST.
      expect(source).not.toMatch(/\/api\/conversations\/\$\{conversationId\}\/messages.*method.*POST/);
    });
  });

  // -------------------------------------------------------------------------
  // A3 — Message send POST security (tenant-scoped)
  // -------------------------------------------------------------------------

  describe("A3 message send tenant authorization", () => {
    function makeSendParams(tenantId: string, conversationId: string) {
      return { params: Promise.resolve({ tenantId, conversationId }) };
    }

    it("POST /api/tenants/:tenantId/conversations/:id/messages — anonymous → 401", async () => {
      mockAuth(null);
      const response = await postMessage(
        new Request("https://example.test/api/tenants/tenant-1/conversations/conv-1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "text", text: "hello" }),
        }),
        makeSendParams("tenant-1", "conv-1"),
      );
      expect(response.status).toBe(401);
    });

    it("POST — missing membership → 403", async () => {
      mockAuth({ user: { id: "user-2", role: "AGENT" } });
      mockResolveResult = new TenantAuthorizationError();
      const response = await postMessage(
        new Request("https://example.test/api/tenants/tenant-1/conversations/conv-1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "text", text: "hello" }),
        }),
        makeSendParams("tenant-1", "conv-1"),
      );
      expect(response.status).toBe(403);
    });

    it("POST — cross-tenant conversation → 404 (no enqueueOutboundMessage called)", async () => {
      mockAuth({ user: { id: "user-1", role: "AGENT" } });
      mockResolveResult = mockTenantContext;
      mockFindConversationResult = null;
      const { enqueueOutboundMessage } = await import("@/lib/whatsapp/send");
      const sendSpy = vi.mocked(enqueueOutboundMessage);
      sendSpy.mockClear();
      const response = await postMessage(
        new Request("https://example.test/api/tenants/tenant-1/conversations/conv-other/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "text", text: "hello" }),
        }),
        makeSendParams("tenant-1", "conv-other"),
      );
      expect(response.status).toBe(404);
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("POST — session window closed returns 403 (no enqueueOutboundMessage called)", async () => {
      mockAuth({ user: { id: "user-1", role: "AGENT" } });
      mockResolveResult = mockTenantContext;
      mockFindConversationResult = conversationRow();
      const { isWithinSessionWindow, enqueueOutboundMessage } = await import("@/lib/whatsapp/send");
      vi.mocked(isWithinSessionWindow).mockReturnValue(false);
      const sendSpy = vi.mocked(enqueueOutboundMessage);
      sendSpy.mockClear();
      const response = await postMessage(
        new Request("https://example.test/api/tenants/tenant-1/conversations/conv-1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "text", text: "hello" }),
        }),
        makeSendParams("tenant-1", "conv-1"),
      );
      expect(response.status).toBe(403);
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("POST — valid text send calls enqueueOutboundMessage with correct args", async () => {
      mockAuth({ user: { id: "user-1", role: "AGENT" } });
      mockResolveResult = mockTenantContext;
      mockFindConversationResult = conversationRow();
      const { isWithinSessionWindow, enqueueOutboundMessage } = await import("@/lib/whatsapp/send");
      vi.mocked(isWithinSessionWindow).mockReturnValue(true);
      const sendSpy = vi.mocked(enqueueOutboundMessage);
      sendSpy.mockClear();
      const response = await postMessage(
        new Request("https://example.test/api/tenants/tenant-1/conversations/conv-1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "text", text: "Hello world" }),
        }),
        makeSendParams("tenant-1", "conv-1"),
      );
      expect(response.status).toBe(202);
      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conv-1",
          to: "919812345678",
          content: { kind: "text", text: "Hello world" },
          sentById: "user-1",
        }),
      );
    });

    it("POST — no external send before conversation ownership is verified", async () => {
      // The enqueueOutboundMessage spy should NOT be called when findConversation is the gatekeeper.
      mockAuth({ user: { id: "user-1", role: "AGENT" } });
      mockResolveResult = mockTenantContext;
      mockFindConversationResult = null; // 404 before send
      const { enqueueOutboundMessage } = await import("@/lib/whatsapp/send");
      const sendSpy = vi.mocked(enqueueOutboundMessage);
      sendSpy.mockClear();
      await postMessage(
        new Request("https://example.test/api/tenants/tenant-1/conversations/conv-not-found/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "text", text: "test" }),
        }),
        makeSendParams("tenant-1", "conv-not-found"),
      );
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("POST — invalid payload → 400 (no enqueueOutboundMessage called)", async () => {
      mockAuth({ user: { id: "user-1", role: "AGENT" } });
      mockResolveResult = mockTenantContext;
      mockFindConversationResult = conversationRow();
      const { isWithinSessionWindow, enqueueOutboundMessage } = await import("@/lib/whatsapp/send");
      vi.mocked(isWithinSessionWindow).mockReturnValue(true);
      const sendSpy = vi.mocked(enqueueOutboundMessage);
      sendSpy.mockClear();
      const response = await postMessage(
        new Request("https://example.test/api/tenants/tenant-1/conversations/conv-1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "text", text: "" }), // empty text = invalid
        }),
        makeSendParams("tenant-1", "conv-1"),
      );
      expect(response.status).toBe(400);
      expect(sendSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Defect 4 — History GET read-marking tenant isolation
  // -------------------------------------------------------------------------

  describe("GET read-marking tenant isolation", () => {
    it("read-marking updateMany includes tenantId predicate", async () => {
      mockAuth({ user: { id: "user-1", role: "AGENT" } });
      mockResolveResult = mockTenantContext;
      mockFindConversationResult = conversationRow({ unreadCount: 3 });
      mockListConversationMessages([]);
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.conversation.updateMany).mockClear();

      await GET(makeRequest("tenant-1", "conv-1"), makeParams("tenant-1", "conv-1"));

      // The updateMany call MUST include tenantId to prevent cross-tenant mutation.
      expect(vi.mocked(prisma.conversation.updateMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: "tenant-1" }),
        }),
      );
    });

    it("read-marking is skipped when conversation not found", async () => {
      mockAuth({ user: { id: "user-1", role: "AGENT" } });
      mockResolveResult = mockTenantContext;
      mockFindConversationResult = null;
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.conversation.updateMany).mockClear();

      const response = await GET(
        makeRequest("tenant-1", "conv-not-found"),
        makeParams("tenant-1", "conv-not-found"),
      );

      expect(response.status).toBe(404);
      expect(vi.mocked(prisma.conversation.updateMany)).not.toHaveBeenCalled();
    });
  });
});
