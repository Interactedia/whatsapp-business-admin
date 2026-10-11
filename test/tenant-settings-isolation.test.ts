import { beforeEach, describe, expect, it, vi } from "vitest";

let mockAuthUser: { id: string; role: string; name: string } | null = null;
const hoistedAuth = vi.hoisted(() => () => Promise.resolve(mockAuthUser ? { user: mockAuthUser } : null));

const mockWabaAccountFindFirst = vi.hoisted(() => vi.fn());
const mockWabaAccountCreate = vi.hoisted(() => vi.fn());
const mockWabaAccountUpdate = vi.hoisted(() => vi.fn());
const mockPhoneNumberCreate = vi.hoisted(() => vi.fn());
const mockPhoneNumberUpdate = vi.hoisted(() => vi.fn());
const mockTenantFindUnique = vi.hoisted(() => vi.fn());
const mockTenantMembershipFindUnique = vi.hoisted(() => vi.fn());
const mockTenantMembershipFindMany = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({
  auth: hoistedAuth,
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: (val: string) => `enc:${val}`,
  decrypt: (val: string) => val.replace(/^enc:/, ""),
  maskSecret: (val: string | null | undefined) => (val ? "masked" : ""),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: {
      findUnique: mockTenantFindUnique,
    },
    tenantMembership: {
      findUnique: mockTenantMembershipFindUnique,
      findMany: mockTenantMembershipFindMany,
    },
    wabaAccount: {
      findFirst: mockWabaAccountFindFirst,
      create: mockWabaAccountCreate,
      update: mockWabaAccountUpdate,
    },
    phoneNumber: {
      create: mockPhoneNumberCreate,
      update: mockPhoneNumberUpdate,
    },
  },
}));

import { GET as getTenantSettings, PUT as putTenantSettings } from "@/app/api/tenants/[tenantId]/settings/route";
import { POST as testTenantSettings } from "@/app/api/tenants/[tenantId]/settings/test/route";
import { GET as getLegacySettings, PUT as putLegacySettings } from "@/app/api/settings/route";

describe("Tenant Settings Isolation and Security Enforcement", () => {
  const tenantA = { id: "tenant-a", name: "Tenant A Org" };
  const tenantB = { id: "tenant-b", name: "Tenant B Org" };

  const adminUserA = { id: "user-admin-a", role: "ADMIN", name: "Admin A" };
  const adminUserB = { id: "user-admin-b", role: "ADMIN", name: "Admin B" };
  const agentUserA = { id: "user-agent-a", role: "AGENT", name: "Agent A" };
  const superAdmin = { id: "user-super", role: "SYSTEM_ADMIN", name: "SuperAdmin" };

  const wabaTenantA = {
    id: "waba-rec-a",
    tenantId: "tenant-a",
    metaWabaId: "waba_id_tenant_a",
    name: "Business Tenant A",
    metaAppId: "app_id_tenant_a",
    accessTokenEnc: "enc:token_tenant_a",
    appSecret: "secret_tenant_a",
    webhookVerifyToken: "verify_tenant_a",
    apiVersion: "v21.0",
    phoneNumbers: [
      {
        id: "phone-rec-a",
        wabaAccountId: "waba-rec-a",
        metaPhoneNumberId: "phone_id_tenant_a",
        displayPhone: "+1 555-0101",
        verifiedName: "Verified Tenant A",
      },
    ],
  };

  const wabaTenantB = {
    id: "waba-rec-b",
    tenantId: "tenant-b",
    metaWabaId: "waba_id_tenant_b",
    name: "Business Tenant B",
    metaAppId: "app_id_tenant_b",
    accessTokenEnc: "enc:token_tenant_b",
    appSecret: "secret_tenant_b",
    webhookVerifyToken: "verify_tenant_b",
    apiVersion: "v22.0",
    phoneNumbers: [
      {
        id: "phone-rec-b",
        wabaAccountId: "waba-rec-b",
        metaPhoneNumberId: "phone_id_tenant_b",
        displayPhone: "+1 555-0202",
        verifiedName: "Verified Tenant B",
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthUser = null;

    mockTenantFindUnique.mockImplementation(async ({ where: { id } }: { where: { id: string } }) => {
      if (id === "tenant-a") return tenantA;
      if (id === "tenant-b") return tenantB;
      return null;
    });

    mockTenantMembershipFindUnique.mockImplementation(
      async ({ where: { userId_tenantId } }: { where: { userId_tenantId: { userId: string; tenantId: string } } }) => {
        const { userId, tenantId } = userId_tenantId;
        if (userId === "user-admin-a" && tenantId === "tenant-a") {
          return { id: "m-a", user: { id: userId, active: true, role: "ADMIN" }, tenant: tenantA };
        }
        if (userId === "user-admin-b" && tenantId === "tenant-b") {
          return { id: "m-b", user: { id: userId, active: true, role: "ADMIN" }, tenant: tenantB };
        }
        if (userId === "user-agent-a" && tenantId === "tenant-a") {
          return { id: "m-agent-a", user: { id: userId, active: true, role: "AGENT" }, tenant: tenantA };
        }
        return null;
      },
    );
  });

  describe("1. Distinct Tenant Settings (Isolation)", () => {
    it("Tenant A admin reads only Tenant A settings", async () => {
      mockAuthUser = adminUserA;
      mockWabaAccountFindFirst.mockImplementation(async ({ where: { tenantId } }: { where: { tenantId: string } }) => {
        if (tenantId === "tenant-a") return wabaTenantA;
        return null;
      });

      const res = await getTenantSettings(new Request("http://localhost/api/tenants/tenant-a/settings"), {
        params: Promise.resolve({ tenantId: "tenant-a" }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.wabaId).toBe("waba_id_tenant_a");
      expect(json.phoneNumberId).toBe("phone_id_tenant_a");
      expect(json.businessName).toBe("Verified Tenant A");
      expect(json.metaAppId).toBe("app_id_tenant_a");
      expect(json.webhookVerifyToken).toBe("verify_tenant_a");
      expect(json.accessTokenSet).toBe(true);
    });

    it("Tenant B admin reads only Tenant B settings", async () => {
      mockAuthUser = adminUserB;
      mockWabaAccountFindFirst.mockImplementation(async ({ where: { tenantId } }: { where: { tenantId: string } }) => {
        if (tenantId === "tenant-b") return wabaTenantB;
        return null;
      });

      const res = await getTenantSettings(new Request("http://localhost/api/tenants/tenant-b/settings"), {
        params: Promise.resolve({ tenantId: "tenant-b" }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.wabaId).toBe("waba_id_tenant_b");
      expect(json.phoneNumberId).toBe("phone_id_tenant_b");
      expect(json.businessName).toBe("Verified Tenant B");
      expect(json.metaAppId).toBe("app_id_tenant_b");
      expect(json.webhookVerifyToken).toBe("verify_tenant_b");
      expect(json.accessTokenSet).toBe(true);
    });
  });

  describe("2. Cross-Tenant Rejection (Authorization)", () => {
    it("rejects Tenant A admin trying to read Tenant B settings with 403", async () => {
      mockAuthUser = adminUserA;
      const res = await getTenantSettings(new Request("http://localhost/api/tenants/tenant-b/settings"), {
        params: Promise.resolve({ tenantId: "tenant-b" }),
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toMatch(/member of the tenant/i);
    });

    it("rejects Tenant B admin trying to read Tenant A settings with 403", async () => {
      mockAuthUser = adminUserB;
      const res = await getTenantSettings(new Request("http://localhost/api/tenants/tenant-a/settings"), {
        params: Promise.resolve({ tenantId: "tenant-a" }),
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toMatch(/member of the tenant/i);
    });

    it("rejects Tenant A admin trying to mutate Tenant B settings with 403", async () => {
      mockAuthUser = adminUserA;
      const res = await putTenantSettings(
        new Request("http://localhost/api/tenants/tenant-b/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wabaId: "malicious_overwrite" }),
        }),
        { params: Promise.resolve({ tenantId: "tenant-b" }) },
      );
      expect(res.status).toBe(403);
      expect(mockWabaAccountUpdate).not.toHaveBeenCalled();
      expect(mockWabaAccountCreate).not.toHaveBeenCalled();
    });

    it("rejects Tenant B admin trying to mutate Tenant A settings with 403", async () => {
      mockAuthUser = adminUserB;
      const res = await putTenantSettings(
        new Request("http://localhost/api/tenants/tenant-a/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wabaId: "malicious_overwrite" }),
        }),
        { params: Promise.resolve({ tenantId: "tenant-a" }) },
      );
      expect(res.status).toBe(403);
      expect(mockWabaAccountUpdate).not.toHaveBeenCalled();
      expect(mockWabaAccountCreate).not.toHaveBeenCalled();
    });
  });

  describe("3. Role Restrictions (AGENT and SYSTEM_ADMIN without membership)", () => {
    it("rejects AGENT user from reading tenant settings with 403", async () => {
      mockAuthUser = agentUserA;
      const res = await getTenantSettings(new Request("http://localhost/api/tenants/tenant-a/settings"), {
        params: Promise.resolve({ tenantId: "tenant-a" }),
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toMatch(/Tenant admin required/i);
    });

    it("rejects AGENT user from modifying tenant settings with 403", async () => {
      mockAuthUser = agentUserA;
      const res = await putTenantSettings(
        new Request("http://localhost/api/tenants/tenant-a/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wabaId: "agent_change" }),
        }),
        { params: Promise.resolve({ tenantId: "tenant-a" }) },
      );
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toMatch(/Tenant admin required/i);
    });

    it("rejects SYSTEM_ADMIN from reading tenant settings if not a member (invariant: SYSTEM_ADMIN does not bypass)", async () => {
      mockAuthUser = superAdmin;
      const res = await getTenantSettings(new Request("http://localhost/api/tenants/tenant-a/settings"), {
        params: Promise.resolve({ tenantId: "tenant-a" }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("4. Missing/Legacy Configuration Fails Closed", () => {
    it("returns empty unconfigured settings for a tenant without WABA (no fallback to default)", async () => {
      mockAuthUser = adminUserA;
      mockWabaAccountFindFirst.mockResolvedValue(null);

      const res = await getTenantSettings(new Request("http://localhost/api/tenants/tenant-a/settings"), {
        params: Promise.resolve({ tenantId: "tenant-a" }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.wabaId).toBe("");
      expect(json.phoneNumberId).toBe("");
      expect(json.connected).toBe(false);
      expect(json.accessTokenSet).toBe(false);
    });

    it("legacy /api/settings fails closed without tenantId (status 400)", async () => {
      mockAuthUser = adminUserA;
      const res = await getLegacySettings(new Request("http://localhost/api/settings"), {
        params: Promise.resolve({}),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/tenantId parameter is required/i);
    });

    it("legacy PUT /api/settings fails closed without tenantId (status 400)", async () => {
      mockAuthUser = adminUserA;
      const res = await putLegacySettings(
        new Request("http://localhost/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wabaId: "123" }),
        }),
        { params: Promise.resolve({}) },
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/tenantId parameter is required/i);
    });
  });

  describe("5. Mutation Isolation", () => {
    it("updates Tenant A WabaAccount and PhoneNumber without affecting Tenant B", async () => {
      mockAuthUser = adminUserA;
      mockWabaAccountFindFirst.mockImplementation(async ({ where: { tenantId } }: { where: { tenantId: string } }) => {
        if (tenantId === "tenant-a") return wabaTenantA;
        return null;
      });
      mockWabaAccountUpdate.mockResolvedValue({ ...wabaTenantA, metaWabaId: "new_waba_a" });
      mockPhoneNumberUpdate.mockResolvedValue({ ...wabaTenantA.phoneNumbers[0], metaPhoneNumberId: "new_phone_a" });

      const res = await putTenantSettings(
        new Request("http://localhost/api/tenants/tenant-a/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wabaId: "new_waba_a",
            phoneNumberId: "new_phone_a",
            accessToken: "new_secret_token",
          }),
        }),
        { params: Promise.resolve({ tenantId: "tenant-a" }) },
      );

      expect(res.status).toBe(200);
      expect(mockWabaAccountUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "waba-rec-a" },
          data: expect.objectContaining({
            metaWabaId: "new_waba_a",
            accessTokenEnc: "enc:new_secret_token",
          }),
        }),
      );
      expect(mockPhoneNumberUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "phone-rec-a" },
          data: expect.objectContaining({
            metaPhoneNumberId: "new_phone_a",
          }),
        }),
      );
    });
  });

  describe("6. Connection Test Endpoint", () => {
    it("rejects cross-tenant test connection call with 403", async () => {
      mockAuthUser = adminUserA;
      const res = await testTenantSettings(new Request("http://localhost/api/tenants/tenant-b/settings/test", { method: "POST" }), {
        params: Promise.resolve({ tenantId: "tenant-b" }),
      });
      expect(res.status).toBe(403);
    });

    it("fails test connection when tenant has no phone number configured", async () => {
      mockAuthUser = adminUserA;
      mockWabaAccountFindFirst.mockResolvedValue(null);
      const res = await testTenantSettings(new Request("http://localhost/api/tenants/tenant-a/settings/test", { method: "POST" }), {
        params: Promise.resolve({ tenantId: "tenant-a" }),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/Phone Number ID/i);
    });
  });
});
