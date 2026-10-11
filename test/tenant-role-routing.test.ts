import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireTenantAdmin, requireTenantAdminApi } from "@/lib/tenant/page-guards";
import { HttpError } from "@/lib/api";

const mockRedirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => mockRedirect(url),
}));

const mockAuth = vi.fn();
vi.mock("@/auth", () => ({
  auth: () => mockAuth(),
}));

const mockFindUnique = vi.fn();
const mockFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMembership: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      findMany: (...args: unknown[]) => mockFindMany(...args),
    },
  },
}));

describe("Tenant Role Page Guards and Routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("requireTenantAdmin (page guard)", () => {
    it("redirects unauthenticated user to /login", async () => {
      mockAuth.mockResolvedValueOnce(null);

      await expect(requireTenantAdmin("tenant-1")).rejects.toThrow("REDIRECT:/login");
      expect(mockRedirect).toHaveBeenCalledWith("/login");
    });

    it("returns null membership and user memberships when not a member of requested tenant", async () => {
      mockAuth.mockResolvedValueOnce({ user: { id: "user-1", role: "ADMIN" } });
      mockFindUnique.mockResolvedValueOnce(null);
      mockFindMany.mockResolvedValueOnce([
        { id: "mem-2", tenantId: "tenant-2", tenant: { id: "tenant-2", name: "Tenant 2" } },
      ]);

      const result = await requireTenantAdmin("tenant-1");
      expect(result.membership).toBeNull();
      expect(result.memberships).toHaveLength(1);
      expect(mockRedirect).not.toHaveBeenCalled();
    });

    it("redirects unauthorized tenant AGENT to /t/{tenantId}/conversations", async () => {
      mockAuth.mockResolvedValueOnce({ user: { id: "user-agent", role: "AGENT" } });
      mockFindUnique.mockResolvedValueOnce({
        id: "mem-1",
        user: { id: "user-agent", active: true, role: "AGENT" },
        tenant: { id: "tenant-1", name: "Tenant 1" },
      });

      await expect(requireTenantAdmin("tenant-1")).rejects.toThrow("REDIRECT:/t/tenant-1/conversations");
      expect(mockRedirect).toHaveBeenCalledWith("/t/tenant-1/conversations");
    });

    it("allows access to tenant ADMIN", async () => {
      mockAuth.mockResolvedValueOnce({ user: { id: "user-admin", role: "ADMIN" } });
      mockFindUnique.mockResolvedValueOnce({
        id: "mem-1",
        user: { id: "user-admin", active: true, role: "ADMIN" },
        tenant: { id: "tenant-1", name: "Tenant 1" },
      });

      const result = await requireTenantAdmin("tenant-1");
      expect(result.membership).not.toBeNull();
      expect(result.membership?.tenant.id).toBe("tenant-1");
      expect(mockRedirect).not.toHaveBeenCalled();
    });

    it("allows access to SYSTEM_ADMIN when member of the tenant", async () => {
      mockAuth.mockResolvedValueOnce({ user: { id: "user-sysadmin", role: "SYSTEM_ADMIN" } });
      mockFindUnique.mockResolvedValueOnce({
        id: "mem-1",
        user: { id: "user-sysadmin", active: true, role: "SYSTEM_ADMIN" },
        tenant: { id: "tenant-1", name: "Tenant 1" },
      });

      const result = await requireTenantAdmin("tenant-1");
      expect(result.membership).not.toBeNull();
      expect(mockRedirect).not.toHaveBeenCalled();
    });

    it("does not allow inactive user even if role is ADMIN", async () => {
      mockAuth.mockResolvedValueOnce({ user: { id: "user-inactive", role: "ADMIN" } });
      mockFindUnique.mockResolvedValueOnce({
        id: "mem-1",
        user: { id: "user-inactive", active: false, role: "ADMIN" },
        tenant: { id: "tenant-1", name: "Tenant 1" },
      });
      mockFindMany.mockResolvedValueOnce([]);

      const result = await requireTenantAdmin("tenant-1");
      expect(result.membership).toBeNull();
    });
  });

  describe("requireTenantAdminApi (API guard)", () => {
    it("denies access with 403 when user is not a member of the tenant", async () => {
      mockFindUnique.mockResolvedValueOnce(null);

      await expect(requireTenantAdminApi("user-1", "tenant-1")).rejects.toBeInstanceOf(HttpError);
    });

    it("denies tenant AGENT with 403 Tenant admin required", async () => {
      mockFindUnique.mockResolvedValueOnce({
        id: "mem-1",
        user: { id: "user-agent", active: true, role: "AGENT" },
        tenant: { id: "tenant-1", name: "Tenant 1" },
      });

      await expect(requireTenantAdminApi("user-agent", "tenant-1")).rejects.toMatchObject({
        status: 403,
        message: "Tenant admin required",
      });
    });

    it("allows tenant ADMIN", async () => {
      mockFindUnique.mockResolvedValueOnce({
        id: "mem-1",
        user: { id: "user-admin", active: true, role: "ADMIN" },
        tenant: { id: "tenant-1", name: "Tenant 1" },
      });

      const result = await requireTenantAdminApi("user-admin", "tenant-1");
      expect(result.id).toBe("mem-1");
    });
  });
});
