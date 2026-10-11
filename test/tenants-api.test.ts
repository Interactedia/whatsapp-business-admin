import { beforeEach, describe, expect, it, vi } from "vitest";

let mockAuthUser: { id: string; role: string; name: string } | null = null;

const hoistedAuth = vi.hoisted(() => () => Promise.resolve(mockAuthUser ? { user: mockAuthUser } : null));

const mockTenantFindMany = vi.hoisted(() => vi.fn());
const mockTenantFindUnique = vi.hoisted(() => vi.fn());
const mockTenantCreate = vi.hoisted(() => vi.fn());
const mockMembershipFindMany = vi.hoisted(() => vi.fn());
const mockMembershipFindUnique = vi.hoisted(() => vi.fn());
const mockMembershipCreate = vi.hoisted(() => vi.fn());
const mockUserFindUnique = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({
  auth: hoistedAuth,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: {
      findMany: mockTenantFindMany,
      findUnique: mockTenantFindUnique,
      create: mockTenantCreate,
    },
    tenantMembership: {
      findMany: mockMembershipFindMany,
      findUnique: mockMembershipFindUnique,
      create: mockMembershipCreate,
    },
    user: {
      findUnique: mockUserFindUnique,
    },
  },
}));

import { GET as getTenants, POST as createTenant } from "@/app/api/tenants/route";
import { GET as getMemberships, POST as createMembership } from "@/app/api/tenants/[tenantId]/memberships/route";

describe("Tenants API and Membership Authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthUser = null;
  });

  describe("GET /api/tenants", () => {
    it("returns 401 when unauthenticated", async () => {
      mockAuthUser = null;
      const res = await getTenants(new Request("http://localhost/api/tenants"), {
        params: Promise.resolve({}),
      });
      expect(res.status).toBe(401);
    });

    it("returns all tenants when caller is SYSTEM_ADMIN", async () => {
      mockAuthUser = { id: "sys-1", role: "SYSTEM_ADMIN", name: "System Admin" };
      mockTenantFindMany.mockResolvedValueOnce([
        { id: "t-1", name: "Tenant 1", _count: { tenantMemberships: 2 } },
        { id: "t-2", name: "Tenant 2", _count: { tenantMemberships: 1 } },
      ]);

      const res = await getTenants(new Request("http://localhost/api/tenants"), {
        params: Promise.resolve({}),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(2);
      expect(mockTenantFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: "desc" } }),
      );
    });

    it("returns only caller's authorized tenants when caller is ordinary ADMIN or AGENT", async () => {
      mockAuthUser = { id: "user-1", role: "ADMIN", name: "Tenant Admin" };
      mockMembershipFindMany.mockResolvedValueOnce([
        { tenant: { id: "t-1", name: "Tenant 1" } },
      ]);

      const res = await getTenants(new Request("http://localhost/api/tenants"), {
        params: Promise.resolve({}),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe("t-1");
      expect(mockMembershipFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "user-1", user: { active: true } } }),
      );
    });
  });

  describe("POST /api/tenants", () => {
    it("returns 401 when unauthenticated", async () => {
      mockAuthUser = null;
      const req = new Request("http://localhost/api/tenants", {
        method: "POST",
        body: JSON.stringify({ name: "New Tenant" }),
      });
      const res = await createTenant(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(401);
    });

    it("returns 403 when caller is not SYSTEM_ADMIN (e.g. tenant ADMIN)", async () => {
      mockAuthUser = { id: "user-1", role: "ADMIN", name: "Tenant Admin" };
      const req = new Request("http://localhost/api/tenants", {
        method: "POST",
        body: JSON.stringify({ name: "New Tenant" }),
      });
      const res = await createTenant(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toContain("System administrator");
      expect(mockTenantCreate).not.toHaveBeenCalled();
    });

    it("returns 201 and creates tenant when caller is SYSTEM_ADMIN", async () => {
      mockAuthUser = { id: "sys-1", role: "SYSTEM_ADMIN", name: "System Admin" };
      mockTenantCreate.mockResolvedValueOnce({
        id: "new-t",
        name: "Acme Corp",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const req = new Request("http://localhost/api/tenants", {
        method: "POST",
        body: JSON.stringify({ name: "Acme Corp" }),
      });
      const res = await createTenant(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toBe("new-t");
      expect(data.name).toBe("Acme Corp");
    });
  });

  describe("POST /api/tenants/[tenantId]/memberships", () => {
    it("returns 401 when unauthenticated", async () => {
      mockAuthUser = null;
      const req = new Request("http://localhost/api/tenants/t-1/memberships", {
        method: "POST",
        body: JSON.stringify({ userId: "target-user" }),
      });
      const res = await createMembership(req, { params: Promise.resolve({ tenantId: "t-1" }) });
      expect(res.status).toBe(401);
    });

    it("returns 404 if tenant does not exist", async () => {
      mockAuthUser = { id: "sys-1", role: "SYSTEM_ADMIN", name: "SysAdmin" };
      mockTenantFindUnique.mockResolvedValueOnce(null);

      const req = new Request("http://localhost/api/tenants/unknown-t/memberships", {
        method: "POST",
        body: JSON.stringify({ userId: "target-user" }),
      });
      const res = await createMembership(req, { params: Promise.resolve({ tenantId: "unknown-t" }) });
      expect(res.status).toBe(404);
    });

    it("returns 403 when caller is tenant AGENT of target tenant", async () => {
      mockAuthUser = { id: "agent-1", role: "AGENT", name: "Agent" };
      mockTenantFindUnique.mockResolvedValueOnce({ id: "t-1", name: "Tenant 1" });
      mockMembershipFindUnique.mockResolvedValueOnce({
        id: "mem-agent",
        user: { active: true, role: "AGENT" },
      });

      const req = new Request("http://localhost/api/tenants/t-1/memberships", {
        method: "POST",
        body: JSON.stringify({ userId: "target-user" }),
      });
      const res = await createMembership(req, { params: Promise.resolve({ tenantId: "t-1" }) });
      expect(res.status).toBe(403);
    });

    it("returns 403 when caller is ADMIN of a foreign tenant", async () => {
      mockAuthUser = { id: "admin-foreign", role: "ADMIN", name: "Foreign Admin" };
      mockTenantFindUnique.mockResolvedValueOnce({ id: "t-1", name: "Tenant 1" });
      // Caller has no membership in t-1
      mockMembershipFindUnique.mockResolvedValueOnce(null);

      const req = new Request("http://localhost/api/tenants/t-1/memberships", {
        method: "POST",
        body: JSON.stringify({ userId: "target-user" }),
      });
      const res = await createMembership(req, { params: Promise.resolve({ tenantId: "t-1" }) });
      expect(res.status).toBe(403);
    });

    it("returns 409 when target user is already a member of the tenant", async () => {
      mockAuthUser = { id: "admin-1", role: "ADMIN", name: "Tenant Admin" };
      mockTenantFindUnique.mockResolvedValueOnce({ id: "t-1", name: "Tenant 1" });
      // Caller membership check
      mockMembershipFindUnique.mockResolvedValueOnce({
        id: "caller-mem",
        user: { active: true, role: "ADMIN" },
      });
      // Target user check
      mockUserFindUnique.mockResolvedValueOnce({
        id: "target-user",
        active: true,
        name: "Target",
        email: "target@example.com",
      });
      // Existing membership check for target user
      mockMembershipFindUnique.mockResolvedValueOnce({
        id: "existing-mem",
        userId: "target-user",
        tenantId: "t-1",
      });

      const req = new Request("http://localhost/api/tenants/t-1/memberships", {
        method: "POST",
        body: JSON.stringify({ userId: "target-user" }),
      });
      const res = await createMembership(req, { params: Promise.resolve({ tenantId: "t-1" }) });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toContain("already a member");
    });

    it("returns 201 when caller is tenant ADMIN and adds an existing user", async () => {
      mockAuthUser = { id: "admin-1", role: "ADMIN", name: "Tenant Admin" };
      mockTenantFindUnique.mockResolvedValueOnce({ id: "t-1", name: "Tenant 1" });
      // Caller membership check
      mockMembershipFindUnique.mockResolvedValueOnce({
        id: "caller-mem",
        user: { active: true, role: "ADMIN" },
      });
      // Target user check
      mockUserFindUnique.mockResolvedValueOnce({
        id: "new-member",
        active: true,
        name: "New Member",
        email: "new@example.com",
      });
      // Existing membership check (none)
      mockMembershipFindUnique.mockResolvedValueOnce(null);
      // Create membership
      mockMembershipCreate.mockResolvedValueOnce({
        id: "created-mem-1",
        userId: "new-member",
        tenantId: "t-1",
        user: { id: "new-member", name: "New Member", email: "new@example.com", role: "AGENT", active: true },
      });

      const req = new Request("http://localhost/api/tenants/t-1/memberships", {
        method: "POST",
        body: JSON.stringify({ userId: "new-member" }),
      });
      const res = await createMembership(req, { params: Promise.resolve({ tenantId: "t-1" }) });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toBe("created-mem-1");
      expect(data.userId).toBe("new-member");
    });

    it("returns 201 when caller is SYSTEM_ADMIN and adds an existing user to tenant", async () => {
      mockAuthUser = { id: "sys-1", role: "SYSTEM_ADMIN", name: "Sys Admin" };
      mockTenantFindUnique.mockResolvedValueOnce({ id: "t-1", name: "Tenant 1" });
      // Target user check
      mockUserFindUnique.mockResolvedValueOnce({
        id: "member-2",
        active: true,
        name: "Member 2",
        email: "m2@example.com",
      });
      // Existing membership check (none)
      mockMembershipFindUnique.mockResolvedValueOnce(null);
      // Create membership
      mockMembershipCreate.mockResolvedValueOnce({
        id: "created-mem-2",
        userId: "member-2",
        tenantId: "t-1",
        user: { id: "member-2", name: "Member 2", email: "m2@example.com", role: "ADMIN", active: true },
      });

      const req = new Request("http://localhost/api/tenants/t-1/memberships", {
        method: "POST",
        body: JSON.stringify({ userId: "member-2" }),
      });
      const res = await createMembership(req, { params: Promise.resolve({ tenantId: "t-1" }) });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toBe("created-mem-2");
    });
  });

  describe("GET /api/tenants/[tenantId]/memberships", () => {
    it("returns 403 if ordinary user is not a member of the tenant", async () => {
      mockAuthUser = { id: "user-outsider", role: "ADMIN", name: "Outsider" };
      mockTenantFindUnique.mockResolvedValueOnce({ id: "t-1", name: "Tenant 1" });
      mockMembershipFindUnique.mockResolvedValueOnce(null);

      const res = await getMemberships(new Request("http://localhost/api/tenants/t-1/memberships"), {
        params: Promise.resolve({ tenantId: "t-1" }),
      });
      expect(res.status).toBe(403);
    });

    it("returns members list when caller is a member", async () => {
      mockAuthUser = { id: "user-member", role: "AGENT", name: "Member" };
      mockTenantFindUnique.mockResolvedValueOnce({ id: "t-1", name: "Tenant 1" });
      mockMembershipFindUnique.mockResolvedValueOnce({
        id: "mem-1",
        user: { active: true },
      });
      mockMembershipFindMany.mockResolvedValueOnce([
        {
          id: "mem-1",
          userId: "user-member",
          tenantId: "t-1",
          user: { id: "user-member", name: "Member", email: "m@example.com", role: "AGENT", active: true },
        },
      ]);

      const res = await getMemberships(new Request("http://localhost/api/tenants/t-1/memberships"), {
        params: Promise.resolve({ tenantId: "t-1" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(1);
    });
  });
});
