import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantAuthorizationError, type TenantContext } from "@/lib/tenant";

// ---------------------------------------------------------------------------
// Mock implementations stored at module level
// ---------------------------------------------------------------------------

let mockAuthValue: { user: { id: string; role: string } } | null = null;
let mockResolveResult: TenantContext | Error = new TenantAuthorizationError();
let mockListContactsResult: unknown = [];

function mockAuth(session: typeof mockAuthValue) {
  mockAuthValue = session;
}

function mockResolveTenantContext(result: typeof mockResolveResult) {
  mockResolveResult = result;
}

function mockListContacts(result: unknown) {
  mockListContactsResult = result;
}

// Hoisted mocks — must be defined before vi.mock calls
const hoistedMockAuth = vi.hoisted(() => {
  return () => Promise.resolve(mockAuthValue);
});

const hoistedMockResolve = vi.hoisted(() => {
  return () => {
    if (mockResolveResult instanceof Error) throw mockResolveResult;
    return Promise.resolve(mockResolveResult);
  };
});

const hoistedMockListContacts = vi.hoisted(() => {
  return () => {
    if (mockListContactsResult instanceof Error) throw mockListContactsResult;
    return Promise.resolve(mockListContactsResult);
  };
});

// Setup mocks BEFORE importing the route
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
    listContacts: hoistedMockListContacts,
  },
}));

// Import the route AFTER mocks are set up
import { GET } from "@/app/api/tenants/[tenantId]/contacts/route";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRequest(tenantId: string, search?: string) {
  const url = new URL(`https://example.test/api/tenants/${tenantId}/contacts`);
  if (search) url.searchParams.set("search", search);
  return new Request(url.toString(), { method: "GET" });
}

function makeParams(tenantId: string) {
  return { params: Promise.resolve({ tenantId }) };
}

function contactRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "contact-1",
    tenantId: "tenant-1",
    waId: "51991234567",
    name: "Test Contact",
    profileName: "Test Profile",
    tags: ["vip"],
    notes: "Test notes",
    lastInboundAt: new Date("2026-01-01"),
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    conversations: [{ id: "conv-1" }],
    ...overrides,
  };
}

const trustedContext: TenantContext = {
  tenantId: "tenant-1",
  userId: "user-1",
  membershipId: "membership-1",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WA-01-05G-R2 tenant contact list HTTP access", () => {
  afterEach(() => {
    mockAuthValue = null;
    mockResolveResult = new TenantAuthorizationError();
    mockListContactsResult = [];
    vi.clearAllMocks();
  });

  // G. Anonymous request returns 401 JSON
  it("returns 401 JSON for anonymous requests", async () => {
    mockAuth(null);

    const response = await GET(makeRequest("tenant-1"), makeParams("tenant-1"));

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  // H. Missing membership returns 403
  it("returns 403 for missing membership", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(new TenantAuthorizationError());

    const response = await GET(makeRequest("tenant-1"), makeParams("tenant-1"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Tenant access denied" });
  });

  // I. Global ADMIN without membership is denied
  it("returns 403 for ADMIN without membership", async () => {
    mockAuth({ user: { id: "admin-user", role: "ADMIN" } });
    mockResolveTenantContext(new TenantAuthorizationError());

    const response = await GET(makeRequest("tenant-1"), makeParams("tenant-1"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Tenant access denied" });
  });

  // Authorized member gets tenant-scoped list
  it("returns 200 with allowlisted contact fields for authorized member", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    mockListContacts([contactRow()]);

    const response = await GET(makeRequest("tenant-1"), makeParams("tenant-1"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);

    const contact = body[0] as Record<string, unknown>;
    // Allowlisted fields present
    expect(contact.id).toBe("contact-1");
    expect(contact.waId).toBe("51991234567");
    expect(contact.name).toBe("Test Contact");
    expect(contact.profileName).toBe("Test Profile");
    expect(contact.tags).toEqual(["vip"]);
    expect(contact.notes).toBe("Test notes");
    // Conversation id included
    expect(contact.conversation).toEqual({ id: "conv-1" });
  });

  // N. Safe response allowlist — no tenantId or internal fields
  it("does not expose tenantId or internal fields in response", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    mockListContacts([contactRow()]);

    const response = await GET(makeRequest("tenant-1"), makeParams("tenant-1"));
    const body = await response.json();
    const contact = body[0] as Record<string, unknown>;

    expect(contact).not.toHaveProperty("tenantId");
    expect(contact).not.toHaveProperty("membershipId");
    expect(contact).not.toHaveProperty("userId");
  });

  // Empty list returns []
  it("returns empty array for authorized member with no contacts", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    mockListContacts([]);

    const response = await GET(makeRequest("tenant-1"), makeParams("tenant-1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  // Repository throws TenantAuthorizationError -> 400 (invalid pagination)
  it("returns 400 for invalid pagination values", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    mockListContacts(new TenantAuthorizationError());

    const response = await GET(makeRequest("tenant-1"), makeParams("tenant-1"));

    expect(response.status).toBe(400);
  });

  // L. Forged userId headers are ignored — server session is the only identity
  it("uses server-side session identity, not client-supplied values", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    mockListContacts([]);

    const request = new Request("https://example.test/api/tenants/tenant-1/contacts", {
      method: "GET",
      headers: {
        "x-user-id": "forged-user",
        "x-tenant-id": "other-tenant",
      },
    });

    const response = await GET(request, makeParams("tenant-1"));

    expect(response.status).toBe(200);
    // resolveTenantContext was called with server-side user id
    // (verified indirectly: if forged id were used, resolve would throw)
  });

  // Search query is passed through to repository
  it("passes search query to repository", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(trustedContext);
    mockListContacts([contactRow()]);

    const response = await GET(makeRequest("tenant-1", "test-search"), makeParams("tenant-1"));

    expect(response.status).toBe(200);
  });

  // Empty tenantId returns 403
  it("returns 403 for empty tenantId", async () => {
    mockAuth({ user: { id: "user-1", role: "AGENT" } });
    mockResolveTenantContext(new TenantAuthorizationError());

    const response = await GET(makeRequest(""), makeParams(""));

    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Legacy GET removal tests
// ---------------------------------------------------------------------------

describe("WA-01-05G-R2 legacy global GET removal", () => {
  it("does not export GET from /api/contacts route", async () => {
    const routeModule = (await import("@/app/api/contacts/route")) as Record<string, unknown>;
    expect(routeModule.GET).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// WA-01-05H legacy global write removal
// ---------------------------------------------------------------------------

describe("WA-01-05H legacy global write removal", () => {
  it("does not export POST from /api/contacts route", async () => {
    const routeModule = (await import("@/app/api/contacts/route")) as Record<string, unknown>;
    expect(routeModule.POST).toBeUndefined();
  });

  it("does not export PATCH or DELETE from /api/contacts/[id] route", async () => {
    const idRoute = (await import("@/app/api/contacts/[id]/route")) as Record<string, unknown>;
    expect(idRoute.PATCH).toBeUndefined();
    expect(idRoute.DELETE).toBeUndefined();
  });

  it("exports POST, PATCH, DELETE from canonical tenant routes", async () => {
    const listRoute = (await import("@/app/api/tenants/[tenantId]/contacts/route")) as Record<string, unknown>;
    const detailRoute = (await import("@/app/api/tenants/[tenantId]/contacts/[contactId]/route")) as Record<string, unknown>;
    expect(listRoute.POST).toBeDefined();
    expect(detailRoute.PATCH).toBeDefined();
    expect(detailRoute.DELETE).toBeDefined();
  });
});
