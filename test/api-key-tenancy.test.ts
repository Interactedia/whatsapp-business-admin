import { beforeEach, describe, expect, it, vi } from "vitest";

const apiKeyFindUnique = vi.hoisted(() => vi.fn());
const apiKeyUpdate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: {
    apiKey: { findUnique: apiKeyFindUnique, update: apiKeyUpdate },
  },
}));

describe("tenant-scoped API key principals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiKeyUpdate.mockResolvedValue({});
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
