/**
 * WA-ERA5-02 — Fail-closed Meta webhook authentication.
 *
 * Approved security decision: every externally received Meta webhook must be
 * verified with HMAC-SHA256 over the UNMODIFIED raw request bytes against an
 * appropriate Meta App Secret. Missing, malformed, invalid or unverifiable
 * signatures must never reach routing, enqueueing, or business mutation.
 *
 * Regression: the previous route only rejected when the GLOBAL app secret was
 * configured (`if (cfg.appSecret && !signatureValid)`). A deployment with no
 * global secret — but tenant secrets, or none at all — accepted unauthenticated
 * bodies. That is what produced signatureValid=false without rejection.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

const getWabaConfig = vi.hoisted(() => vi.fn());
const wabaAccountFindMany = vi.hoisted(() => vi.fn());

vi.mock("@/lib/settings", () => ({ getWabaConfig }));
vi.mock("@/lib/prisma", () => ({
  prisma: { wabaAccount: { findMany: wabaAccountFindMany } },
}));

const GLOBAL_SECRET = "global_app_secret_for_tests";
const TENANT_SECRET = "tenant_a_app_secret_for_tests";

function sign(body: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/** Representative real Meta inbound webhook body. */
const META_BODY = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [{
    id: "107113523193",
    changes: [{
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        metadata: { display_phone_number: "15551234567", phone_number_id: "109876543210" },
        contacts: [{ profile: { name: "Ada" }, wa_id: "5215550000111" }],
        messages: [{
          from: "5215550000111",
          id: "wamid.HBgNMTA3MTEzNTIzMTkzEgAUMwAARJ0FEXAMPLE+xyz/ABC==",
          timestamp: "1728000000",
          type: "text",
          text: { body: "hello from Meta" },
        }],
      },
    }],
  }],
});

async function loadAuth() {
  return import("@/lib/whatsapp/inbound/auth");
}

describe("authenticateMetaWebhook — fail-closed policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWabaConfig.mockResolvedValue({ appSecret: null });
    wabaAccountFindMany.mockResolvedValue([]);
  });

  it("rejects when no App Secret is configured anywhere", async () => {
    const { authenticateMetaWebhook } = await loadAuth();
    const result = await authenticateMetaWebhook(META_BODY, sign(META_BODY, GLOBAL_SECRET));

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.reason).toBe("APP_SECRET_UNCONFIGURED");
      expect(result.missingSecret).toBe(true);
      expect(result.signatureValid).toBe(false);
    }
  });

  it("rejects a missing signature header even when a secret is configured", async () => {
    getWabaConfig.mockResolvedValue({ appSecret: GLOBAL_SECRET });
    const { authenticateMetaWebhook } = await loadAuth();
    const result = await authenticateMetaWebhook(META_BODY, null);

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) expect(result.reason).toBe("SIGNATURE_MISSING");
  });

  it("rejects an empty signature header", async () => {
    getWabaConfig.mockResolvedValue({ appSecret: GLOBAL_SECRET });
    const { authenticateMetaWebhook } = await loadAuth();
    const result = await authenticateMetaWebhook(META_BODY, "");

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) expect(result.reason).toBe("SIGNATURE_MISSING");
  });

  it("rejects a malformed signature header", async () => {
    getWabaConfig.mockResolvedValue({ appSecret: GLOBAL_SECRET });
    const { authenticateMetaWebhook } = await loadAuth();

    for (const malformed of ["sha1=abc", "sha256=not-hex", "sha256=", "garbage", "sha256=" + "0".repeat(63)]) {
      const result = await authenticateMetaWebhook(META_BODY, malformed);
      expect(result.authenticated).toBe(false);
      if (!result.authenticated) expect(result.reason).toBe("SIGNATURE_MALFORMED");
    }
  });

  it("rejects a signature computed with the wrong secret", async () => {
    getWabaConfig.mockResolvedValue({ appSecret: GLOBAL_SECRET });
    const { authenticateMetaWebhook } = await loadAuth();
    const result = await authenticateMetaWebhook(META_BODY, sign(META_BODY, "attacker_guess"));

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) expect(result.reason).toBe("SIGNATURE_INVALID");
  });

  it("rejects a valid signature over tampered body bytes", async () => {
    getWabaConfig.mockResolvedValue({ appSecret: GLOBAL_SECRET });
    const { authenticateMetaWebhook } = await loadAuth();
    // Signature is valid for the original body; the delivered body differs.
    const result = await authenticateMetaWebhook(META_BODY + " ", sign(META_BODY, GLOBAL_SECRET));

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) expect(result.reason).toBe("SIGNATURE_INVALID");
  });

  it("accepts a valid signature verified with the global App Secret", async () => {
    getWabaConfig.mockResolvedValue({ appSecret: GLOBAL_SECRET });
    const { authenticateMetaWebhook } = await loadAuth();
    const result = await authenticateMetaWebhook(META_BODY, sign(META_BODY, GLOBAL_SECRET));

    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.secretSource).toBe("global");
      expect(result.signatureValid).toBe(true);
    }
  });

  it("accepts a valid signature verified with a tenant App Secret", async () => {
    wabaAccountFindMany.mockResolvedValue([{ appSecret: TENANT_SECRET }]);
    const { authenticateMetaWebhook } = await loadAuth();
    const result = await authenticateMetaWebhook(META_BODY, sign(META_BODY, TENANT_SECRET));

    expect(result.authenticated).toBe(true);
    if (result.authenticated) expect(result.secretSource).toBe("tenant");
  });

  it("rejects when a tenant secret exists but does not match", async () => {
    wabaAccountFindMany.mockResolvedValue([{ appSecret: TENANT_SECRET }]);
    const { authenticateMetaWebhook } = await loadAuth();
    const result = await authenticateMetaWebhook(META_BODY, sign(META_BODY, GLOBAL_SECRET));

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) expect(result.reason).toBe("SIGNATURE_INVALID");
  });

  it("never reports authenticated=true together with signatureValid=false", async () => {
    getWabaConfig.mockResolvedValue({ appSecret: GLOBAL_SECRET });
    const { authenticateMetaWebhook } = await loadAuth();

    const results = await Promise.all([
      authenticateMetaWebhook(META_BODY, sign(META_BODY, GLOBAL_SECRET)),
      authenticateMetaWebhook(META_BODY, null),
      authenticateMetaWebhook(META_BODY, "sha256=" + "f".repeat(64)),
      authenticateMetaWebhook(META_BODY, "sha1=deadbeef"),
    ]);

    for (const result of results) {
      expect(result.signatureValid).toBe(result.authenticated);
    }
  });
});

describe("authentication result never leaks secret material", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWabaConfig.mockResolvedValue({ appSecret: GLOBAL_SECRET });
    wabaAccountFindMany.mockResolvedValue([{ appSecret: TENANT_SECRET }]);
  });

  it("serializes without any configured secret value", async () => {
    const { authenticateMetaWebhook } = await loadAuth();
    const result = await authenticateMetaWebhook(META_BODY, sign(META_BODY, TENANT_SECRET));
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(GLOBAL_SECRET);
    expect(serialized).not.toContain(TENANT_SECRET);
    // The signature value itself is never stored on the result either.
    expect(serialized).not.toContain(sign(META_BODY, TENANT_SECRET).replace("sha256=", ""));
  });
});

describe("signature helper contract", () => {
  it("isMetaSignatureValid verifies raw bytes with the given secret", async () => {
    const { isMetaSignatureValid } = await loadAuth();
    const header = sign(META_BODY, GLOBAL_SECRET);

    expect(isMetaSignatureValid(META_BODY, header, GLOBAL_SECRET)).toBe(true);
    expect(isMetaSignatureValid(META_BODY, header, TENANT_SECRET)).toBe(false);
    expect(isMetaSignatureValid(META_BODY, null, GLOBAL_SECRET)).toBe(false);
  });

  it("signMetaWebhookBody produces a header the verifier accepts", async () => {
    const { signMetaWebhookBody, isMetaSignatureValid } = await loadAuth();
    const header = signMetaWebhookBody(META_BODY, GLOBAL_SECRET);

    expect(header.startsWith("sha256=")).toBe(true);
    expect(isMetaSignatureValid(META_BODY, header, GLOBAL_SECRET)).toBe(true);
  });

  it("rejects a body that was re-serialized (whitespace-sensitive)", async () => {
    const { signMetaWebhookBody, isMetaSignatureValid } = await loadAuth();
    const header = signMetaWebhookBody(META_BODY, GLOBAL_SECRET);
    const reserialized = JSON.stringify(JSON.parse(META_BODY), null, 2);

    expect(isMetaSignatureValid(reserialized, header, GLOBAL_SECRET)).toBe(false);
  });
});
