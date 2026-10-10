import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertTenantOwned, resolveTenantContext, TenantAuthorizationError } from "@/lib/tenant";

const findUnique = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMembership: { findUnique },
  },
}));

describe("WA-01-05A centralized tenant authorization", () => {
  beforeEach(() => {
    findUnique.mockReset();
  });

  it("resolves context for a valid persisted membership", async () => {
    findUnique.mockResolvedValueOnce({
      id: "membership-1",
      user: { id: "user-1", active: true },
      tenant: { id: "tenant-1" },
    });

    await expect(resolveTenantContext({ userId: "user-1" }, "tenant-1")).resolves.toEqual({
      tenantId: "tenant-1",
      userId: "user-1",
      membershipId: "membership-1",
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { userId_tenantId: { userId: "user-1", tenantId: "tenant-1" } },
      select: {
        id: true,
        user: { select: { id: true, active: true } },
        tenant: { select: { id: true } },
      },
    });
  });

  it("denies missing membership", async () => {
    findUnique.mockResolvedValueOnce(null);

    await expect(resolveTenantContext({ userId: "user-1" }, "tenant-1")).rejects.toBeInstanceOf(
      TenantAuthorizationError,
    );
  });

  it("denies unknown tenant without leaking existence", async () => {
    findUnique.mockResolvedValueOnce(null);

    await expect(resolveTenantContext({ userId: "user-1" }, "unknown-tenant")).rejects.toMatchObject({
      message: "Tenant access denied",
    });
  });

  it("denies missing principal before querying membership", async () => {
    await expect(resolveTenantContext(null, "tenant-1")).rejects.toBeInstanceOf(TenantAuthorizationError);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("denies invalid inactive principal", async () => {
    findUnique.mockResolvedValueOnce({
      id: "membership-1",
      user: { id: "user-1", active: false },
      tenant: { id: "tenant-1" },
    });

    await expect(resolveTenantContext({ userId: "user-1" }, "tenant-1")).rejects.toBeInstanceOf(
      TenantAuthorizationError,
    );
  });

  it("denies malformed tenant identifier", async () => {
    await expect(resolveTenantContext({ userId: "user-1" }, "")).rejects.toBeInstanceOf(TenantAuthorizationError);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("uses only the server-verified principal for membership lookup", async () => {
    findUnique.mockResolvedValueOnce(null);

    await expect(resolveTenantContext({ userId: "actual-user" }, "tenant-1")).rejects.toBeInstanceOf(
      TenantAuthorizationError,
    );
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_tenantId: { userId: "actual-user", tenantId: "tenant-1" } } }),
    );
  });

  it("keeps multiple tenant memberships isolated by requested tenant", async () => {
    findUnique.mockResolvedValueOnce({
      id: "membership-2",
      user: { id: "user-1", active: true },
      tenant: { id: "tenant-2" },
    });

    await expect(resolveTenantContext({ userId: "user-1" }, "tenant-2")).resolves.toMatchObject({
      tenantId: "tenant-2",
      userId: "user-1",
    });
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_tenantId: { userId: "user-1", tenantId: "tenant-2" } } }),
    );
  });

  it("does not allow global ADMIN role to bypass tenant membership", async () => {
    findUnique.mockResolvedValueOnce(null);

    await expect(
      resolveTenantContext({ userId: "admin-user", role: "ADMIN" } as { userId: string }, "tenant-1"),
    ).rejects.toBeInstanceOf(TenantAuthorizationError);
  });

  it("denies missing resource ownership", () => {
    expect(() => assertTenantOwned({ tenantId: "tenant-1", userId: "user-1", membershipId: "m1" }, null)).toThrow(
      TenantAuthorizationError,
    );
    expect(() =>
      assertTenantOwned({ tenantId: "tenant-1", userId: "user-1", membershipId: "m1" }, { tenantId: null }),
    ).toThrow(TenantAuthorizationError);
  });

  it("rejects cross-tenant ownership mismatch", () => {
    expect(() =>
      assertTenantOwned({ tenantId: "tenant-1", userId: "user-1", membershipId: "m1" }, { tenantId: "tenant-2" }),
    ).toThrow(TenantAuthorizationError);
  });
});
