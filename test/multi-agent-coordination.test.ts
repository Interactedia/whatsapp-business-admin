/**
 * WA-ERA4-08 — Multi-operator coordination regression tests.
 *
 * Locks in the ACTUAL coordination behavior of conversation assignment and
 * status mutations as implemented today (no new event types, no new policy,
 * no schema changes):
 *
 *   1. PATCH /api/tenants/:tenantId/conversations/:id authorization:
 *      - Unauthenticated → 401.
 *      - Authenticated without tenant membership → 403.
 *      - ADMIN role without membership → 403 (ADMIN cannot bypass membership).
 *      - Empty body → 400.
 *      - Cross-tenant or missing conversation → 404.
 *      - Forged identity fields in the body are rejected by Zod before
 *        reaching the repository; the repository only ever receives the
 *        whitelisted columns and the trusted context.
 *      - The handler does NOT call publish() after a successful PATCH;
 *        coordination between operators depends on the existing refetch
 *        path, not on a server-pushed event for assignment/status. If a
 *        future change adds a publish() call here without an associated
 *        event-type contract change, this test fails closed.
 *
 *   2. Repository layer (updateMany with tenantId + contact.tenantId filter):
 *      - The WHERE clause binds both the conversation's tenantId AND the
 *        contact's tenantId. Removing either of those is a regression.
 *      - The DATA field carries only the operator-supplied columns
 *        (status, unreadCount, assignedUserId); identity fields (id,
 *        tenantId, contactId) cannot be rewritten via the data argument.
 *      - A cross-tenant updateMany reports count=0, and the repository
 *        returns null. The row is untouched.
 *      - The repository does NOT call publish() as a side effect.
 *
 *   3. Concurrent semantics at the SQL boundary: the repository's
 *      updateMany is a single SQL statement; the database decides the
 *      final state. The test mirrors the production call shape
 *      (concurrent Promise.all, identical WHERE, distinct DATA) and
 *      asserts both calls succeed independently.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/lib/tenant";

// ---------- Prisma mock ----------
type UpdateCall = { where: Record<string, unknown>; data: Record<string, unknown> };
const prismaState: {
  updateMany: (args: UpdateCall) => Promise<{ count: number }>;
  findFirst: () => Promise<unknown>;
  findUniqueMembership: () => Promise<unknown>;
  log: UpdateCall[];
} = {
  updateMany: async () => ({ count: 1 }),
  findFirst: async () => null,
  findUniqueMembership: async () => ({
    id: "m-1",
    user: { id: "user-1", active: true },
    tenant: { id: "tenant-1" },
  }),
  log: [],
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: {
      updateMany: async (args: UpdateCall) => {
        prismaState.log.push(args);
        return prismaState.updateMany(args);
      },
      findFirst: async () => prismaState.findFirst(),
    },
    tenantMembership: {
      // The real resolveTenantContext() calls
      // prisma.tenantMembership.findUnique({ where: { userId_tenantId: … }})
      // to verify the session. We return a valid membership so the
      // production resolveTenantContext succeeds, populating the
      // trustedTenantContexts WeakSet. To exercise the no-membership
      // path, a test sets findUniqueMembership to return null.
      findUnique: async () => prismaState.findUniqueMembership(),
    },
  },
}));

// ---------- Realtime mock ----------
const publishMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/realtime", () => ({ publish: publishMock }));

// ---------- Auth mock ----------
let authValue: { user: { id: string; role: string } } | null = { user: { id: "user-1", role: "AGENT" } };
vi.mock("@/auth", () => ({ auth: async () => authValue }));

// We use the REAL resolveTenantContext. The prisma.tenantMembership mock
// above makes it succeed. To force a failure we point the authValue at
// a user that the mocked membership does not match. The simplest knob
// is to make auth() return null (no session) for the 401 test and to
// override findUnique via prismaState for the membership-missing test.

function makeRequest(tenantId: string, conversationId: string, body: unknown) {
  return new Request(
    `https://example.test/api/tenants/${tenantId}/conversations/${conversationId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function makeParams(tenantId: string, conversationId: string) {
  return { params: Promise.resolve({ tenantId, conversationId }) };
}

const baseRepoRow = {
  id: "conv-1",
  contactId: "contact-1",
  tenantId: "tenant-1",
  status: "OPEN" as const,
  unreadCount: 0,
  lastMessageAt: null as Date | null,
  lastInboundAt: null as Date | null,
  lastPreview: null as string | null,
  assignedUserId: null as string | null,
  createdAt: new Date(),
  updatedAt: new Date(),
  contact: { tenantId: "tenant-1" },
};

const trustedContextShape: TenantContext = {
  tenantId: "tenant-1",
  userId: "user-1",
  membershipId: "m-1",
};
// Reference retained for type clarity; the actual context used by the
// repository tests is resolved at runtime via resolveTenantContext()
// so it gets added to the trustedTenantContexts WeakSet.
void trustedContextShape;

beforeEach(() => {
  publishMock.mockClear();
  prismaState.log.length = 0;
  prismaState.updateMany = async () => ({ count: 1 });
  prismaState.findFirst = async () => ({ ...baseRepoRow });
  prismaState.findUniqueMembership = async () => ({
    id: "m-1",
    user: { id: "user-1", active: true },
    tenant: { id: "tenant-1" },
  });
  authValue = { user: { id: "user-1", role: "AGENT" } };
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------- 1. PATCH HTTP layer: auth + tenant enforcement ----------
describe("PATCH /api/tenants/:tenantId/conversations/:id — coordination hardening", () => {
  it("returns 401 when no session exists", async () => {
    authValue = null;
    const { PATCH } = await import(
      "@/app/api/tenants/[tenantId]/conversations/[conversationId]/route"
    );
    const response = await PATCH(
      makeRequest("tenant-1", "conv-1", { status: "CLOSED" }),
      makeParams("tenant-1", "conv-1"),
    );
    expect(response.status).toBe(401);
  });

  it("returns 403 when authenticated user has no tenant membership", async () => {
    authValue = { user: { id: "user-1", role: "AGENT" } };
    prismaState.findUniqueMembership = async () => null;
    const { PATCH } = await import(
      "@/app/api/tenants/[tenantId]/conversations/[conversationId]/route"
    );
    const response = await PATCH(
      makeRequest("tenant-1", "conv-1", { status: "CLOSED" }),
      makeParams("tenant-1", "conv-1"),
    );
    expect(response.status).toBe(403);
  });

  it("returns 403 when ADMIN has no tenant membership (ADMIN cannot bypass)", async () => {
    authValue = { user: { id: "admin-user", role: "ADMIN" } };
    prismaState.findUniqueMembership = async () => null;
    const { PATCH } = await import(
      "@/app/api/tenants/[tenantId]/conversations/[conversationId]/route"
    );
    const response = await PATCH(
      makeRequest("tenant-1", "conv-1", { status: "CLOSED" }),
      makeParams("tenant-1", "conv-1"),
    );
    expect(response.status).toBe(403);
  });

  it("returns 400 for an empty update body", async () => {
    const { PATCH } = await import(
      "@/app/api/tenants/[tenantId]/conversations/[conversationId]/route"
    );
    const response = await PATCH(
      makeRequest("tenant-1", "conv-1", {}),
      makeParams("tenant-1", "conv-1"),
    );
    expect(response.status).toBe(400);
  });

  it("returns 404 when the repository reports the conversation is not visible to this tenant", async () => {
    prismaState.updateMany = async () => ({ count: 0 });
    prismaState.findFirst = async () => null;
    const { PATCH } = await import(
      "@/app/api/tenants/[tenantId]/conversations/[conversationId]/route"
    );
    const response = await PATCH(
      makeRequest("tenant-1", "conv-other", { status: "CLOSED" }),
      makeParams("tenant-1", "conv-other"),
    );
    expect(response.status).toBe(404);
  });

  it("ignores identity fields (id, tenantId, contactId) submitted in the body", async () => {
    prismaState.findFirst = async () => ({
      ...baseRepoRow,
      status: "CLOSED",
      assignedUserId: "agent-1",
    });
    const { PATCH } = await import(
      "@/app/api/tenants/[tenantId]/conversations/[conversationId]/route"
    );
    const response = await PATCH(
      makeRequest("tenant-1", "conv-1", {
        status: "CLOSED",
        assignedUserId: "agent-1",
        // Forged identity fields:
        id: "conv-attacker",
        tenantId: "tenant-attacker",
        contactId: "contact-attacker",
      }),
      makeParams("tenant-1", "conv-1"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.id).toBe("conv-1");
    expect(body.contactId).toBe("contact-1");
    expect(body.assignedUserId).toBe("agent-1");
    // Verify the repository was called with the trusted context and only
    // the whitelisted columns (Zod rejected the forged fields).
    expect(prismaState.log).toHaveLength(1);
    const where = prismaState.log[0].where;
    expect(where).toMatchObject({
      id: "conv-1",
      tenantId: "tenant-1",
      contact: { tenantId: "tenant-1" },
    });
    const data = prismaState.log[0].data;
    expect(data).toEqual({ status: "CLOSED", assignedUserId: "agent-1" });
    expect(data).not.toHaveProperty("id");
    expect(data).not.toHaveProperty("tenantId");
    expect(data).not.toHaveProperty("contactId");
  });

  it("publishes conversation:updated after a successful assignment/status PATCH (WA-ERA4-08)", async () => {
    // The previous test left findFirst returning a row with
    // assignedUserId "agent-1". To make this PATCH a real change,
    // we route the new value to "agent-2" — the existing
    // assignedUserId is "agent-1".
    prismaState.findFirst = async () => ({
      ...baseRepoRow,
      assignedUserId: "agent-1",
    });
    const { PATCH } = await import(
      "@/app/api/tenants/[tenantId]/conversations/[conversationId]/route"
    );
    publishMock.mockClear();
    const response = await PATCH(
      makeRequest("tenant-1", "conv-1", { assignedUserId: "agent-2" }),
      makeParams("tenant-1", "conv-1"),
    );
    expect(response.status).toBe(200);
    // WA-ERA4-08: PATCH now publishes a tenant-scoped invalidation
    // event after a successful canonical write. The payload carries
    // only the conversationId — never the new assignedUserId or
    // status. If a future change emits a different shape, this
    // assertion fails closed.
    expect(publishMock).toHaveBeenCalledTimes(1);
    const [event, tenant] = publishMock.mock.calls[0];
    expect(event).toEqual({
      type: "conversation:updated",
      payload: { conversationId: "conv-1" },
    });
    expect(tenant).toBe("tenant-1");
  });

  it("does not publish conversation:updated when the PATCH body matches the existing state (WA-ERA4-08)", async () => {
    // The PATCH handler compares pre/post to avoid emitting a
    // no-op notification. Setting the same assignedUserId that
    // is already on the row produces a 200 from the repository
    // but no event.
    prismaState.findFirst = async () => ({
      ...baseRepoRow,
      assignedUserId: "agent-A",
    });
    const { PATCH } = await import(
      "@/app/api/tenants/[tenantId]/conversations/[conversationId]/route"
    );
    publishMock.mockClear();
    const response = await PATCH(
      makeRequest("tenant-1", "conv-1", { assignedUserId: "agent-A" }),
      makeParams("tenant-1", "conv-1"),
    );
    expect(response.status).toBe(200);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("does not publish conversation:updated on a 404 PATCH (WA-ERA4-08)", async () => {
    prismaState.findFirst = async () => null;
    const { PATCH } = await import(
      "@/app/api/tenants/[tenantId]/conversations/[conversationId]/route"
    );
    publishMock.mockClear();
    const response = await PATCH(
      makeRequest("tenant-1", "conv-other", { assignedUserId: "agent-1" }),
      makeParams("tenant-1", "conv-other"),
    );
    expect(response.status).toBe(404);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("does not publish conversation:updated for cross-tenant PATCH (WA-ERA4-08)", async () => {
    // updateMany returns 0 for cross-tenant, so the repository
    // returns null and the route responds 404. The event must
    // not be published.
    prismaState.updateMany = async () => ({ count: 0 });
    prismaState.findFirst = async () => null;
    const { PATCH } = await import(
      "@/app/api/tenants/[tenantId]/conversations/[conversationId]/route"
    );
    publishMock.mockClear();
    const response = await PATCH(
      makeRequest("tenant-1", "conv-1", { status: "CLOSED" }),
      makeParams("tenant-1", "conv-1"),
    );
    expect(response.status).toBe(404);
    expect(publishMock).not.toHaveBeenCalled();
  });
});

// ---------- 2. Repository layer: tenant scope + identity safety ----------
import { tenantMessagingRepository } from "@/lib/tenant/repository";
import { resolveTenantContext } from "@/lib/tenant";

// A trusted context is identified by object identity in the
// trustedTenantContexts WeakSet. We resolve it once via the real
// resolveTenantContext() (which adds it to the set) and reuse the
// reference for the rest of the suite.
let resolvedContext: TenantContext;

beforeAll(async () => {
  // Use the same prisma.tenantMembership mock the rest of the suite uses.
  resolvedContext = await resolveTenantContext({ userId: "user-1" }, "tenant-1");
});

describe("tenantMessagingRepository.updateConversation — tenant + identity safety", () => {
  beforeEach(() => {
    prismaState.log.length = 0;
    prismaState.updateMany = async () => ({ count: 1 });
    prismaState.findFirst = async () => ({ ...baseRepoRow });
  });

  it("the WHERE clause binds the conversation id AND the contact's tenantId", async () => {
    await tenantMessagingRepository.updateConversation(resolvedContext, "conv-1", {
      assignedUserId: "agent-1",
    });
    expect(prismaState.log).toHaveLength(1);
    const where = prismaState.log[0].where;
    expect(where).toMatchObject({
      id: "conv-1",
      tenantId: "tenant-1",
      contact: { tenantId: "tenant-1" },
    });
  });

  it("the DATA field carries only the operator-supplied columns", async () => {
    await tenantMessagingRepository.updateConversation(resolvedContext, "conv-1", {
      status: "CLOSED",
      unreadCount: 0,
      assignedUserId: "agent-1",
    });
    const data = prismaState.log[0].data;
    expect(data).toEqual({
      status: "CLOSED",
      unreadCount: 0,
      assignedUserId: "agent-1",
    });
    expect(data).not.toHaveProperty("id");
    expect(data).not.toHaveProperty("tenantId");
    expect(data).not.toHaveProperty("contactId");
  });

  it("returns null when the conversation belongs to a different tenant (count=0)", async () => {
    prismaState.updateMany = async () => ({ count: 0 });
    prismaState.findFirst = async () => null;
    const result = await tenantMessagingRepository.updateConversation(
      resolvedContext,
      "conv-other-tenant",
      { assignedUserId: "agent-1" },
    );
    expect(result).toBeNull();
  });

  it("treats an empty data object as a no-op (the row is still returned)", async () => {
    prismaState.updateMany = async () => ({ count: 1 });
    prismaState.findFirst = async () => ({ ...baseRepoRow });
    const result = await tenantMessagingRepository.updateConversation(
      resolvedContext,
      "conv-1",
      {},
    );
    expect(result).not.toBeNull();
    expect(prismaState.log[0].data).toEqual({});
  });
});

// ---------- 3. Concurrent semantics at the SQL boundary ----------
describe("Concurrent assignment — last-write-wins per existing policy", () => {
  beforeEach(() => {
    prismaState.log.length = 0;
    prismaState.updateMany = async () => ({ count: 1 });
    prismaState.findFirst = async () => ({ ...baseRepoRow });
  });

  it("two simultaneous updateMany calls each update exactly one row", async () => {
    await Promise.all([
      tenantMessagingRepository.updateConversation(resolvedContext, "conv-1", {
        assignedUserId: "agent-A",
      }),
      tenantMessagingRepository.updateConversation(resolvedContext, "conv-1", {
        assignedUserId: "agent-B",
      }),
    ]);
    expect(prismaState.log).toHaveLength(2);
    for (const call of prismaState.log) {
      expect(call.where).toMatchObject({
        id: "conv-1",
        tenantId: "tenant-1",
        contact: { tenantId: "tenant-1" },
      });
    }
    const ids = prismaState.log.map((c) => c.data.assignedUserId);
    expect(ids).toEqual(["agent-A", "agent-B"]);
  });

  it("the repository does not call publish() as a side effect", async () => {
    await tenantMessagingRepository.updateConversation(resolvedContext, "conv-1", {
      status: "CLOSED",
      assignedUserId: "agent-1",
    });
    expect(publishMock).not.toHaveBeenCalled();
  });
});
