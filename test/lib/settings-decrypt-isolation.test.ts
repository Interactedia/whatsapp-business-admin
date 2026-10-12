/**
 * Regression test for the bounded fix to getWabaConfig / getTenantWabaConfig.
 *
 * Symptom: /api/webhook returned 500 Internal Server Error when the stored
 * accessTokenEnc blob was encrypted with a different ENCRYPTION_KEY than
 * the one currently loaded. decrypt()'s GCM auth-tag check threw and the
 * error propagated to the route handler.
 *
 * The webhook verification handshake only reads `webhookVerifyToken`
 * (stored in cleartext). The handshake MUST succeed even when the
 * access-token blob is unreadable; the operator can rotate the token
 * afterwards. This test pins that contract.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    wabaSettings: { findUnique: vi.fn() },
    wabaAccount: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn(),
  encrypt: vi.fn(),
  maskSecret: vi.fn(),
}));

describe("settings: decrypt() failure isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getWabaConfig returns accessToken=null when decrypt() throws (corrupted blob)", async () => {
    const { decrypt } = await import("@/lib/crypto");
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(decrypt).mockImplementation(() => {
      throw new Error(
        "Unsupported state or unable to authenticate data",
      );
    });
    vi.mocked(prisma.wabaSettings.findUnique).mockResolvedValue({
      id: "default",
      wabaId: "waba-1",
      metaAppId: "app-1",
      phoneNumberId: "phone-1",
      phoneNumberDisplay: "+1 555 0100",
      businessName: "Acme",
      accessTokenEnc: "base64blob-from-another-key",
      appSecret: "app-secret",
      webhookVerifyToken: "verify-me",
      apiVersion: "v21.0",
    } as never);

    const { getWabaConfig } = await import("@/lib/settings");
    const cfg = await getWabaConfig();

    // The handshake-relevant field must remain populated.
    expect(cfg.webhookVerifyToken).toBe("verify-me");
    expect(cfg.phoneNumberId).toBe("phone-1");
    expect(cfg.businessName).toBe("Acme");
    // The access token degrades to null instead of throwing.
    expect(cfg.accessToken).toBeNull();
  });

  it("getTenantWabaConfig returns accessToken=null when decrypt() throws", async () => {
    const { decrypt } = await import("@/lib/crypto");
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(decrypt).mockImplementation(() => {
      throw new Error("Unsupported state or unable to authenticate data");
    });
    vi.mocked(prisma.wabaAccount.findFirst).mockResolvedValue({
      id: "acc-1",
      tenantId: "tenant-x",
      name: "Acme",
      metaWabaId: "waba-1",
      metaAppId: "app-1",
      appSecret: "app-secret",
      accessTokenEnc: "base64blob-from-another-key",
      webhookVerifyToken: "verify-me",
      apiVersion: "v21.0",
      phoneNumbers: [
        {
          id: "pn-1",
          wabaAccountId: "acc-1",
          metaPhoneNumberId: "phone-1",
          displayPhone: "+1 555 0100",
          verifiedName: "Acme Verified",
        },
      ],
    } as never);

    const { getTenantWabaConfig } = await import("@/lib/settings");
    const cfg = await getTenantWabaConfig("tenant-x");

    expect(cfg).not.toBeNull();
    expect(cfg!.webhookVerifyToken).toBe("verify-me");
    expect(cfg!.phoneNumberId).toBe("phone-1");
    expect(cfg!.accessToken).toBeNull();
  });

  it("getWabaConfig returns the decrypted token when decrypt() succeeds", async () => {
    const { decrypt } = await import("@/lib/crypto");
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(decrypt).mockReturnValue("EAAB...decrypted-access-token");
    vi.mocked(prisma.wabaSettings.findUnique).mockResolvedValue({
      id: "default",
      accessTokenEnc: "valid-blob",
      webhookVerifyToken: "verify-me",
    } as never);

    const { getWabaConfig } = await import("@/lib/settings");
    const cfg = await getWabaConfig();
    expect(cfg.accessToken).toBe("EAAB...decrypted-access-token");
  });

  it("getWabaConfig returns accessToken=null when the row has no encrypted blob", async () => {
    const { decrypt } = await import("@/lib/crypto");
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.wabaSettings.findUnique).mockResolvedValue({
      id: "default",
      accessTokenEnc: null,
      webhookVerifyToken: "verify-me",
    } as never);

    const { getWabaConfig } = await import("@/lib/settings");
    const cfg = await getWabaConfig();
    expect(cfg.accessToken).toBeNull();
    // decrypt() is not called when there is nothing to decrypt.
    expect(decrypt).not.toHaveBeenCalled();
  });
});
