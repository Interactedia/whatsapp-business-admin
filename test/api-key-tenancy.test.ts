import { beforeEach, describe, expect, it, vi } from "vitest";

const apiKeyFindMany = vi.hoisted(() => vi.fn());
const apiKeyFindUnique = vi.hoisted(() => vi.fn());
const apiKeyUpdate = vi.hoisted(() => vi.fn());
const tenantMembershipFindMany = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: {
    apiKey: { findMany: apiKeyFindMany, findUnique: apiKeyFindUnique, update: apiKeyUpdate },
    tenantMembership: { findMany: tenantMembershipFindMany },
  },
}));

describe("tenant-scoped API key principals", () => {
  it("lists only keys from the caller's tenant memberships", async () => {
    vi.doMock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "user-1", role: "ADMIN" } })) }));
    tenantMembershipFindMany.mockResolvedValue([{ tenantId: "tenant-1" }]);
    apiKeyFindMany.mockResolvedValue([{ id: "key-1", tenantId: "tenant-1" }]);

    const { GET } = await import("@/app/api/apikeys/route");
    const response = await GET(new Request("https://example.test/api/apikeys"), { params: Promise.resolve({}) });

    expect(response.status).toBe(200);
    expect(apiKeyFindMany).toHaveBeenCalledWith({
      where: { revoked: false, tenantId: { in: ["tenant-1"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, keyPrefix: true, lastUsedAt: true, createdAt: true, tenantId: true },
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    apiKeyUpdate.mockResolvedValue({});
    apiKeyFindMany.mockResolvedValue([]);
    tenantMembershipFindMany.mockResolvedValue([]);
  });

  it("derives tenantId from the stored API key", async () => {
    const { generateKey, verifyApiKey } = await import("@/lib/api-keys");
    const key = generateKey();
    apiKeyFindUnique.mockResolvedValue({
      id: "key-1",
      keyHash: key.keyHash,
      createdById: "user-1",
      tenantId: "tenant-1",
      revoked: false,
    });

    await expect(verifyApiKey(key.plaintext)).resolves.toEqual({
      apiKeyId: "key-1",
      userId: "user-1",
      tenantId: "tenant-1",
    });
  });

  it("keeps legacy null-owned keys untrusted for tenant context", async () => {
    const { generateKey, verifyApiKey } = await import("@/lib/api-keys");
    const { resolveApiKeyTenantContext } = await import("@/lib/tenant");
    const key = generateKey();
    apiKeyFindUnique.mockResolvedValue({
      id: "legacy-key",
      keyHash: key.keyHash,
      createdById: "user-1",
      tenantId: null,
      revoked: false,
    });

    const principal = await verifyApiKey(key.plaintext);
    await expect(resolveApiKeyTenantContext(principal)).rejects.toMatchObject({ name: "TenantAuthorizationError" });
  });
});
