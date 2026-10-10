import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantAuthorizationError, type TenantContext } from "@/lib/tenant";

let mockAuthValue: { user: { id: string; role: string } } | null = null;
let mockResolveResult: TenantContext | Error = new TenantAuthorizationError();
let mockFindConversationResult: unknown = null;

function mockAuth(session: typeof mockAuthValue) {
  mockAuthValue = session;
}

function mockResolveTenantContext(result: typeof mockResolveResult) {
  mockResolveResult = result;
}

function mockFindConversation(result: unknown) {
  mockFindConversationResult = result;
}

const findConversationSpy = vi.hoisted(() => vi.fn());
const resolveTenantContextSpy = vi.hoisted(() => vi.fn());

const hoistedMockAuth = vi.hoisted(() => {
  return () => Promise.resolve(mockAuthValue);
});

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

vi.mock("@/auth", () => ({
  auth: hoistedMockAuth,
}));

vi.mock("@/lib/tenant", () => ({
  resolveTenantContext: hoistedMockResolve,
  TenantAuthorizationError: class TenantAuthorizationError extends Error {
    constructor() {
      super("Tenant access denied");
      this.name = "TenantAuthorizationError";
    }
  },
}));

vi.mock("@/lib/tenant/repository", () => ({
  tenantMessagingRepository: {
    findConversation: hoistedMockFindConversation,
  },
}));

import { GET as getContact } from "@/app/api/tenants/[tenantId]/contacts/[contactId]/route";
import { GET } from "@/app/api/tenants/[tenantId]/conversations/[conversationId]/route";

function makeRequest(tenantId: string, conversationId: string) {
  return new Request(`https://example.test/api/tenants/${tenantId}/conversations/${conversationId}`, {
    method: "GET",
  });
}

function makeParams(tenantId: string, conversationId: string) {
  return { params: Promise.resolve({ tenantId, conversationId }) };
}

function makeContactParams(tenantId: string, contactId: string) {
  return { params: Promise.resolve({ tenantId, contactId }) };
}

function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "conversation-1",
    tenantId: "tenant-1",
    contactId: "contact-1",
    contact: { id: "contact-1", tenantId: "tenant-1" },
    status: "OPEN",
    unreadCount: 2,
    lastMessageAt: new Date("2026-01-02"),
    lastInboundAt: new Date("2026-01-01"),
    lastPreview: "hello",
    assignedUserId: "agent-1",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-03"),
    messages: [{ id: "message-1" }],
    secret: "do-not-leak",
    ...overrides,
  };
}

const trustedContext: TenantContext = {
  tenantId: "tenant-1",
  userId: "user-1",
  membershipId: "membership-1",
};

describe("WA-01-05D tenant conversation HTTP access", () => {
  afterEach(() => {
    mockAuthValue = null;
    mockResolveResult = new TenantAuthorizationError();
    mockFindConversationResult = null;
    vi.clearAllMocks();
  });

  it("returns 200 with allowlisted conversation for authorized tenant member", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    mockFindConversation(conversationRow());

    const response = await GET(makeRequest("tenant-1", "conversation-1"), makeParams("tenant-1", "conversation-1"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      id: "conversation-1",
      contactId: "contact-1",
      status: "OPEN",
      unreadCount: 2,
      lastPreview: "hello",
      assignedUserId: "agent-1",
    });
  });

  it("returns 401 when no session exists", async () => {
    mockAuth(null);

    const response = await GET(makeRequest("tenant-1", "conversation-1"), makeParams("tenant-1", "conversation-1"));

    expect(response.status).toBe(401);
    expect(findConversationSpy).not.toHaveBeenCalled();
  });

  it("returns 403 when user has no tenant membership", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(new TenantAuthorizationError());

    const response = await GET(makeRequest("tenant-1", "conversation-1"), makeParams("tenant-1", "conversation-1"));

    expect(response.status).toBe(403);
    expect(findConversationSpy).not.toHaveBeenCalled();
  });

  it("returns 403 when ADMIN has no tenant membership", async () => {
    mockAuth({ user: { id: "admin-user", role: "ADMIN" } });
    mockResolveTenantContext(new TenantAuthorizationError());

    const response = await GET(makeRequest("tenant-1", "conversation-1"), makeParams("tenant-1", "conversation-1"));

    expect(response.status).toBe(403);
    expect(findConversationSpy).not.toHaveBeenCalled();
  });

  it("returns 404 for cross-tenant conversation", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    mockFindConversation(null);

    const response = await GET(makeRequest("tenant-1", "conversation-other"), makeParams("tenant-1", "conversation-other"));

    expect(response.status).toBe(404);
  });

  it("returns 404 for null-owned conversation", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    mockFindConversation(null);

    const response = await GET(makeRequest("tenant-1", "conversation-null"), makeParams("tenant-1", "conversation-null"));

    expect(response.status).toBe(404);
  });

  it("returns 404 when conversation does not exist", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    mockFindConversation(null);

    const response = await GET(makeRequest("tenant-1", "missing"), makeParams("tenant-1", "missing"));

    expect(response.status).toBe(404);
  });

  it("returns 404 for contact ownership mismatch", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    mockFindConversation(null);

    const response = await GET(makeRequest("tenant-1", "contact-mismatch"), makeParams("tenant-1", "contact-mismatch"));

    expect(response.status).toBe(404);
  });

  it("does not use forged userId from headers", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    mockFindConversation(conversationRow());

    const req = new Request(makeRequest("tenant-1", "conversation-1"), {
      headers: { "X-User-Id": "forged-user-id" },
    });

    const response = await GET(req, makeParams("tenant-1", "conversation-1"));

    expect(response.status).toBe(200);
    expect(resolveTenantContextSpy).toHaveBeenCalledWith({ userId: "user-1" }, "tenant-1");
  });

  it("handles malformed conversationId as not found", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    // Repository id parsing rejects malformed ids with TenantAuthorizationError.
    mockFindConversation(new TenantAuthorizationError());

    const response = await GET(makeRequest("tenant-1", ""), makeParams("tenant-1", ""));

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("Conversation not found");
  });

  it("exposes only allowlisted fields", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    mockFindConversation(conversationRow());

    const response = await GET(makeRequest("tenant-1", "conversation-1"), makeParams("tenant-1", "conversation-1"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual([
      "assignedUserId",
      "contactId",
      "createdAt",
      "id",
      "lastInboundAt",
      "lastMessageAt",
      "lastPreview",
      "status",
      "unreadCount",
      "updatedAt",
    ]);
    expect(body).not.toHaveProperty("tenantId");
    expect(body).not.toHaveProperty("contact");
    expect(body).not.toHaveProperty("messages");
    expect(body).not.toHaveProperty("secret");
  });

  it("invokes repository after authorization with trusted context", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    mockFindConversation(conversationRow());

    const response = await GET(makeRequest("tenant-1", "conversation-1"), makeParams("tenant-1", "conversation-1"));

    expect(response.status).toBe(200);
    expect(findConversationSpy).toHaveBeenCalledWith(trustedContext, "conversation-1");
  });

  it("preserves existing tenant contact endpoint behavior", async () => {
    mockAuth(null);

    const response = await getContact(
      new Request("https://example.test/api/tenants/tenant-1/contacts/contact-1", { method: "GET" }),
      makeContactParams("tenant-1", "contact-1"),
    );

    expect(response.status).toBe(401);
  });
});
