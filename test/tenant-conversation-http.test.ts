import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantAuthorizationError, type TenantContext } from "@/lib/tenant";

let mockAuthValue: { user: { id: string; role: string } } | null = null;
let mockResolveResult: TenantContext | Error = new TenantAuthorizationError();
let mockFindConversationResult: unknown = null;
let mockListConversationsResult: unknown[] = [];
let mockCreateConversationResult: unknown = null;
let mockUpdateConversationResult: unknown = null;

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

function mockCreateConversation(result: unknown) {
  mockCreateConversationResult = result;
}

function mockUpdateConversation(result: unknown) {
  mockUpdateConversationResult = result;
}

const findConversationSpy = vi.hoisted(() => vi.fn());
const resolveTenantContextSpy = vi.hoisted(() => vi.fn());
const listConversationsSpy = vi.hoisted(() => vi.fn());
const createConversationSpy = vi.hoisted(() => vi.fn());
const updateConversationSpy = vi.hoisted(() => vi.fn());

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

const hoistedMockCreateConversation = vi.hoisted(() => {
  return (...args: unknown[]) => {
    createConversationSpy(...args);
    if (mockCreateConversationResult instanceof Error) throw mockCreateConversationResult;
    return Promise.resolve(mockCreateConversationResult);
  };
});

const hoistedMockUpdateConversation = vi.hoisted(() => {
  return (...args: unknown[]) => {
    updateConversationSpy(...args);
    if (mockUpdateConversationResult instanceof Error) throw mockUpdateConversationResult;
    return Promise.resolve(mockUpdateConversationResult);
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
    createConversation: hoistedMockCreateConversation,
    updateConversation: hoistedMockUpdateConversation,
    // Also mock updateConversation so it doesn't call through to real findConversation.
    // In tests that don't set mockUpdateConversationResult, default to null.
  },
}));

import { GET as getContact } from "@/app/api/tenants/[tenantId]/contacts/[contactId]/route";
import { GET, PATCH } from "@/app/api/tenants/[tenantId]/conversations/[conversationId]/route";
import { GET as getConversationList, POST as postConversation } from "@/app/api/tenants/[tenantId]/conversations/route";

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
    mockCreateConversationResult = null;
    mockUpdateConversationResult = null;
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

  // -------------------------------------------------------------------------
  // A1 — Conversation creation POST security (tenant-scoped)
  // -------------------------------------------------------------------------

  it("POST /api/tenants/:tenantId/conversations — anonymous → 401", async () => {
    mockAuth(null);
    const response = await postConversation(
      new Request("https://example.test/api/tenants/tenant-1/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ waId: "919812345678" }),
      }),
      makeListParams("tenant-1"),
    );
    expect(response.status).toBe(401);
  });

  it("POST /api/tenants/:tenantId/conversations — missing membership → 403", async () => {
    mockAuth({ user: { id: "user-2", role: "AGENT" } });
    mockResolveTenantContext(new TenantAuthorizationError());
    const response = await postConversation(
      new Request("https://example.test/api/tenants/tenant-1/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ waId: "919812345678" }),
      }),
      makeListParams("tenant-1"),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Tenant access denied" });
  });

  it("POST /api/tenants/:tenantId/conversations — ADMIN without membership → 403", async () => {
    mockAuth({ user: { id: "admin-user", role: "ADMIN" } });
    mockResolveTenantContext(new TenantAuthorizationError());
    const response = await postConversation(
      new Request("https://example.test/api/tenants/tenant-2/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ waId: "919812345678" }),
      }),
      makeListParams("tenant-2"),
    );
    expect(response.status).toBe(403);
  });

  it("POST /api/tenants/:tenantId/conversations — null-owned contact → 403", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    // Repository throws TenantAuthorizationError when the upserted contact is not owned by the tenant.
    mockCreateConversation(new TenantAuthorizationError());
    const response = await postConversation(
      new Request("https://example.test/api/tenants/tenant-1/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ waId: "919812345678" }),
      }),
      makeListParams("tenant-1"),
    );
    expect(response.status).toBe(403);
  });

  it("POST /api/tenants/:tenantId/conversations — success returns conversation id", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    mockCreateConversation({
      conversation: { id: "conv-new-1" },
      contact: { id: "contact-new-1" },
    });
    const response = await postConversation(
      new Request("https://example.test/api/tenants/tenant-1/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ waId: "919812345678", name: "Jane" }),
      }),
      makeListParams("tenant-1"),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ id: "conv-new-1", contactId: "contact-new-1" });
    expect(createConversationSpy).toHaveBeenCalledWith(trustedContext, { waId: "919812345678", name: "Jane" });
  });

  it("POST /api/tenants/:tenantId/conversations — invalid waId → 400", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    const response = await postConversation(
      new Request("https://example.test/api/tenants/tenant-1/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ waId: "not-a-phone-number" }),
      }),
      makeListParams("tenant-1"),
    );
    expect(response.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // A2 — Conversation mutation PATCH security (tenant-scoped)
  // -------------------------------------------------------------------------

  it("PATCH /api/tenants/:tenantId/conversations/:id — anonymous → 401", async () => {
    mockAuth(null);
    const response = await PATCH(
      new Request("https://example.test/api/tenants/tenant-1/conversations/conv-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "CLOSED" }),
      }),
      makeParams("tenant-1", "conv-1"),
    );
    expect(response.status).toBe(401);
  });

  it("PATCH /api/tenants/:tenantId/conversations/:id — missing membership → 403", async () => {
    mockAuth({ user: { id: "user-2", role: "AGENT" } });
    mockResolveTenantContext(new TenantAuthorizationError());
    const response = await PATCH(
      new Request("https://example.test/api/tenants/tenant-1/conversations/conv-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "CLOSED" }),
      }),
      makeParams("tenant-1", "conv-1"),
    );
    expect(response.status).toBe(403);
  });

  it("PATCH /api/tenants/:tenantId/conversations/:id — cross-tenant → 404", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    // Cross-tenant conversation not found — set to null (NOT an Error instance).
    mockFindConversation(null);
    const response = await PATCH(
      new Request("https://example.test/api/tenants/tenant-1/conversations/conv-other-tenant", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "CLOSED" }),
      }),
      makeParams("tenant-1", "conv-other-tenant"),
    );
    expect(response.status).toBe(404);
    // updateConversation returns null for cross-tenant — 404 is returned.
    // Note: hoistedMockUpdateConversation is called with null result (not an Error).
  });

  it("PATCH /api/tenants/:tenantId/conversations/:id — success updates conversation", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    mockFindConversation(conversationRow());
    mockUpdateConversation(conversationRow({ status: "CLOSED" }));
    const response = await PATCH(
      new Request("https://example.test/api/tenants/tenant-1/conversations/conv-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "CLOSED" }),
      }),
      makeParams("tenant-1", "conv-1"),
    );
    expect(response.status).toBe(200);
    expect(updateConversationSpy).toHaveBeenCalledWith(
      trustedContext,
      "conv-1",
      { status: "CLOSED" },
    );
  });

  it("PATCH /api/tenants/:tenantId/conversations/:id — no fields → 400", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    mockFindConversation(conversationRow());
    const response = await PATCH(
      new Request("https://example.test/api/tenants/tenant-1/conversations/conv-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      makeParams("tenant-1", "conv-1"),
    );
    expect(response.status).toBe(400);
  });

  it("PATCH /api/tenants/:tenantId/conversations/:id — forged identity in body is ignored", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    mockFindConversation(conversationRow());
    mockUpdateConversation(conversationRow({ status: "CLOSED" }));
    const response = await PATCH(
      new Request("https://example.test/api/tenants/tenant-1/conversations/conv-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        // Attempt to forge tenantId or reassign conversation.
        body: JSON.stringify({ status: "CLOSED", tenantId: "attacker-tenant" }),
      }),
      makeParams("tenant-1", "conv-1"),
    );
    // tenantId is not in updateSchema so it is ignored. The update succeeds with the URL tenant.
    expect(response.status).toBe(200);
    // Verify the repository was called with trusted context tenant, not the forged one.
    expect(updateConversationSpy).toHaveBeenCalledWith(
      trustedContext,
      "conv-1",
      { status: "CLOSED" },
    );
  });
});
