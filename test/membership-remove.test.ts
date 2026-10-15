/**
 * WA-FIX-001 — Remove tenant membership authorization + last-admin protection.
 *
 * Focused security/authorization tests for DELETE
 * /api/tenants/:tenantId/memberships?userId=<id>. Mirrors the mock style of
 * tenants-api.test.ts. Verifies:
 *   - SYSTEM_ADMIN-only authority (anonymous / AGENT / tenant ADMIN rejected);
 *   - last effective administrator cannot be removed (409, no delete);
 *   - an ADMIN with another active ADMIN member CAN be removed;
 *   - a plain AGENT membership is removed (delete targets only that row);
 *   - validation: unknown tenant / user / membership -> 404 (no stray delete);
 *   - missing userId -> 400.
 * Concurrency (advisory-lock serialization) is covered by the real-Postgres
 * HTTP scenario, not here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockAuthUser: { id: string; role: string; name: string } | null = null;

const hoistedAuth = vi.hoisted(() => () => Promise.resolve(mockAuthUser ? { user: mockAuthUser } : null));

const mockTenantFindUnique = vi.hoisted(() => vi.fn());
const mockUserFindUnique = vi.hoisted(() => vi.fn());
const mockMembershipFindUnique = vi.hoisted(() => vi.fn());
const mockMembershipCount = vi.hoisted(() => vi.fn());
const mockMembershipDelete = vi.hoisted(() => vi.fn());
const mockExecuteRaw = vi.hoisted(() => vi.fn());
const mockTransaction = vi.hoisted(() =>
  vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      $executeRaw: mockExecuteRaw,
      tenantMembership: { count: mockMembershipCount, delete: mockMembershipDelete },
    }),
  ),
);

vi.mock("@/auth", () => ({ auth: hoistedAuth }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: mockTenantFindUnique },
    user: { findUnique: mockUserFindUnique },
    tenantMembership: { findUnique: mockMembershipFindUnique },
    $transaction: mockTransaction,
  },
}));

import { DELETE as removeMembership } from "@/app/api/tenants/[tenantId]/memberships/route";

function del(tenantId: string, userId?: string) {
  const qs = userId ? `?userId=${encodeURIComponent(userId)}` : "";
  return removeMembership(new Request(`http://localhost/api/tenants/${tenantId}/memberships${qs}`, { method: "DELETE" }), {
    params: Promise.resolve({ tenantId }),
  });
}

describe("DELETE /api/tenants/[tenantId]/memberships", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthUser = null;
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await del("t-1", "u-1");
    expect(res.status).toBe(401);
    expect(mockMembershipDelete).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is a tenant ADMIN (no global authority)", async () => {
    mockAuthUser = { id: "admin-1", role: "ADMIN", name: "Tenant Admin" };
    const res = await del("t-1", "u-1");
    expect(res.status).toBe(403);
    expect(mockTenantFindUnique).not.toHaveBeenCalled();
    expect(mockMembershipDelete).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is an AGENT", async () => {
    mockAuthUser = { id: "agent-1", role: "AGENT", name: "Agent" };
    const res = await del("t-1", "u-1");
    expect(res.status).toBe(403);
    expect(mockMembershipDelete).not.toHaveBeenCalled();
  });

  it("returns 400 when userId is missing", async () => {
    mockAuthUser = { id: "sys-1", role: "SYSTEM_ADMIN", name: "SysAdmin" };
    const res = await del("t-1");
    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("returns 404 when tenant does not exist and performs no delete", async () => {
    mockAuthUser = { id: "sys-1", role: "SYSTEM_ADMIN", name: "SysAdmin" };
    mockTenantFindUnique.mockResolvedValueOnce(null);
    const res = await del("unknown-t", "u-1");
    expect(res.status).toBe(404);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("returns 404 when the membership does not exist (no other row deleted)", async () => {
    mockAuthUser = { id: "sys-1", role: "SYSTEM_ADMIN", name: "SysAdmin" };
    mockTenantFindUnique.mockResolvedValueOnce({ id: "t-1" });
    mockUserFindUnique.mockResolvedValueOnce({ id: "u-1", role: "AGENT", active: true });
    mockMembershipFindUnique.mockResolvedValueOnce(null);
    const res = await del("t-1", "u-1");
    expect(res.status).toBe(404);
    expect(mockMembershipDelete).not.toHaveBeenCalled();
  });

  it("returns 409 and does NOT delete when removing the last effective administrator", async () => {
    mockAuthUser = { id: "sys-1", role: "SYSTEM_ADMIN", name: "SysAdmin" };
    mockTenantFindUnique.mockResolvedValueOnce({ id: "t-1" });
    mockUserFindUnique.mockResolvedValueOnce({ id: "admin-1", role: "ADMIN", active: true });
    mockMembershipFindUnique.mockResolvedValueOnce({ id: "mem-admin" });
    mockMembershipCount.mockResolvedValueOnce(0); // no other active ADMIN

    const res = await del("t-1", "admin-1");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("last administrator");
    expect(mockMembershipDelete).not.toHaveBeenCalled();
  });

  it("removes an ADMIN when another active ADMIN member remains", async () => {
    mockAuthUser = { id: "sys-1", role: "SYSTEM_ADMIN", name: "SysAdmin" };
    mockTenantFindUnique.mockResolvedValueOnce({ id: "t-1" });
    mockUserFindUnique.mockResolvedValueOnce({ id: "admin-1", role: "ADMIN", active: true });
    mockMembershipFindUnique.mockResolvedValueOnce({ id: "mem-admin" });
    mockMembershipCount.mockResolvedValueOnce(1); // one other active ADMIN

    const res = await del("t-1", "admin-1");
    expect(res.status).toBe(200);
    expect(mockMembershipDelete).toHaveBeenCalledWith({ where: { id: "mem-admin" } });
  });

  it("removes a plain AGENT membership (only that row) without last-admin count", async () => {
    mockAuthUser = { id: "sys-1", role: "SYSTEM_ADMIN", name: "SysAdmin" };
    mockTenantFindUnique.mockResolvedValueOnce({ id: "t-1" });
    mockUserFindUnique.mockResolvedValueOnce({ id: "agent-1", role: "AGENT", active: true });
    mockMembershipFindUnique.mockResolvedValueOnce({ id: "mem-agent" });

    const res = await del("t-1", "agent-1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ deleted: true, userId: "agent-1", tenantId: "t-1" });
    // AGENT removal must not depend on the admin count
    expect(mockMembershipCount).not.toHaveBeenCalled();
    expect(mockMembershipDelete).toHaveBeenCalledWith({ where: { id: "mem-agent" } });
  });
});
