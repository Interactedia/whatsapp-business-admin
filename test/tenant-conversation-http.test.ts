import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantAuthorizationError, type TenantContext } from "@/lib/tenant";

let mockAuthValue: { user: { id: string; role: string } } | null = null;
let mockResolveResult: TenantContext | Error = new TenantAuthorizationError();
let mockFindConversationResult: unknown = null;
let mockListConversationsResult: unknown[] = [];

function mockAuth(session: typeof mockAuthValue) {
  mockAuthValue = session;
}

function mockResolveTenantContext(result: typeof mockResolveResult) {
  mockResolveResult = result;
}

function mockFindConversation(result: unknown) {
  mockFindConversationResult = result;
}

function mockListConversations(result: unknown[]) {
  mockListConversationsResult = result;
}

const findConversationSpy = vi.hoisted(() => vi.fn());
const resolveTenantContextSpy = vi.hoisted(() => vi.fn());
const listConversationsSpy = vi.hoisted(() => vi.fn());

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

const hoistedMockListConversations = vi.hoisted(() => {
  return (...args: unknown[]) => {
    listConversationsSpy(...args);
    return Promise.resolve(mockListConversationsResult);
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
    listConversations: hoistedMockListConversations,
  },
}));

import { GET as getContact } from "@/app/api/tenants/[tenantId]/contacts/[contactId]/route";
import { GET } from "@/app/api/tenants/[tenantId]/conversations/[conversationId]/route";
import { GET as getConversationList } from "@/app/api/tenants/[tenantId]/conversations/route";

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

function conversationListRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "conversation-1",
    tenantId: "tenant-1",
    contactId: "contact-1",
    contact: { id: "contact-1", waId: "919812345678", name: "John", profileName: "John D", tenantId: "tenant-1" },
    status: "OPEN",
    unreadCount: 2,
    lastMessageAt: new Date("2026-01-02"),
    lastInboundAt: new Date("2026-01-01"),
    lastPreview: "hello world",
    assignedUserId: "agent-1",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-03"),
    internal: "secret-data",
    ...overrides,
  };
}

function makeListParams(tenantId: string) {
  return { params: Promise.resolve({ tenantId }) };
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
    mockListConversationsResult = [];
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
});

describe("WA-01-05I tenant conversation list HTTP access", () => {
  afterEach(() => {
    mockAuthValue = null;
    mockResolveResult = new TenantAuthorizationError();
    mockListConversationsResult = [];
    vi.clearAllMocks();
  });

  it("returns 200 with allowlisted conversation list for authorized tenant member", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    mockListConversations([conversationListRow()]);

    const response = await getConversationList(
      new Request("https://example.test/api/tenants/tenant-1/conversations"),
      makeListParams("tenant-1"),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toBeInstanceOf(Array);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: "conversation-1",
      contact: { id: "contact-1", waId: "919812345678", name: "John", profileName: "John D" },
      status: "OPEN",
      unreadCount: 2,
      lastPreview: "hello world",
      assignedUserId: "agent-1",
    });
  });

  it("returns 401 when no session exists", async () => {
    mockAuth(null);

    const response = await getConversationList(
      new Request("https://example.test/api/tenants/tenant-1/conversations"),
      makeListParams("tenant-1"),
    );

    expect(response.status).toBe(401);
    expect(listConversationsSpy).not.toHaveBeenCalled();
  });

  it("returns 403 when user has no tenant membership", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(new TenantAuthorizationError());

    const response = await getConversationList(
      new Request("https://example.test/api/tenants/tenant-1/conversations"),
      makeListParams("tenant-1"),
    );

    expect(response.status).toBe(403);
    expect(listConversationsSpy).not.toHaveBeenCalled();
  });

  it("returns 403 when ADMIN has no tenant membership", async () => {
    mockAuth({ user: { id: "admin-user", role: "ADMIN" } });
    mockResolveTenantContext(new TenantAuthorizationError());

    const response = await getConversationList(
      new Request("https://example.test/api/tenants/tenant-1/conversations"),
      makeListParams("tenant-1"),
    );

    expect(response.status).toBe(403);
    expect(listConversationsSpy).not.toHaveBeenCalled();
  });

  it("does not use forged userId from headers", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    mockListConversations([conversationListRow()]);

    const req = new Request("https://example.test/api/tenants/tenant-1/conversations", {
      headers: { "X-User-Id": "forged-user-id" },
    });

    const response = await getConversationList(req, makeListParams("tenant-1"));

    expect(response.status).toBe(200);
    expect(resolveTenantContextSpy).toHaveBeenCalledWith({ userId: "user-1" }, "tenant-1");
  });

  it("exposes only allowlisted fields in list response", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    mockListConversations([conversationListRow({ internal: "should-not-appear" })]);

    const response = await getConversationList(
      new Request("https://example.test/api/tenants/tenant-1/conversations"),
      makeListParams("tenant-1"),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toBeInstanceOf(Array);
    const keys = Object.keys(body[0]).sort();
    expect(keys).toEqual([
      "assignedUserId",
      "contact",
      "createdAt",
      "id",
      "lastInboundAt",
      "lastMessageAt",
      "lastPreview",
      "status",
      "unreadCount",
      "updatedAt",
      "windowOpen",
    ]);
    expect(body[0]).not.toHaveProperty("tenantId");
    expect(body[0]).not.toHaveProperty("messages");
    expect(body[0]).not.toHaveProperty("internal");
  });

  it("invokes listConversations with trusted context", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    mockListConversations([]);

    const response = await getConversationList(
      new Request("https://example.test/api/tenants/tenant-1/conversations"),
      makeListParams("tenant-1"),
    );

    expect(response.status).toBe(200);
    expect(listConversationsSpy).toHaveBeenCalledWith(trustedContext, { take: 200 });
  });

  it("legacy global conversation list GET is removed; POST migrated to tenant API", async () => {
    const routeModule = (await import("@/app/api/conversations/route")) as Record<string, unknown>;
    expect(routeModule.GET).toBeUndefined();
    // POST removed — superseded by /api/tenants/:tenantId/conversations
    expect(routeModule.POST).toBeUndefined();
  });

  it("migrated UI no longer consumes the global list GET", async () => {
    // Read the inbox-client source to confirm it no longer hardcodes /api/conversations.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("src/app/(app)/inbox/inbox-client.tsx", "utf-8"),
    );
    expect(source).not.toMatch(/apiFetch<Conversation\[\]>\(`\/api\/conversations/);
    expect(source).toContain("conversationsUrl");
  });

  it("preserves existing tenant conversation detail endpoint behavior", async () => {
    mockAuth(null);

    const response = await getContact(
      new Request("https://example.test/api/tenants/tenant-1/contacts/contact-1", { method: "GET" }),
      makeContactParams("tenant-1", "contact-1"),
    );

    expect(response.status).toBe(401);
  });
});
