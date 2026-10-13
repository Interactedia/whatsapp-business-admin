/**
 * WA-ERA5-02 — Meta webhook route: fail-closed authentication.
 *
 * Defects covered:
 *  - Unauthenticated bodies were processed whenever the GLOBAL app secret was
 *    absent, so `signatureValid=false` never meant "stop".
 *  - A rejected delivery could still leave business records behind, because
 *    authentication was evaluated after routing began.
 *
 * These assertions pin the ORDER of operations: authentication first, then —
 * only for authenticated bodies — routing/enqueueing/mutation. A rejected
 * delivery writes exactly one `WebhookEvent` audit row and touches nothing in
 * the Contact/Conversation/Message domain.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

const webhookEventCreate = vi.hoisted(() => vi.fn());
const webhookEventUpdate = vi.hoisted(() => vi.fn());
const contactUpsert = vi.hoisted(() => vi.fn());
const conversationFindFirst = vi.hoisted(() => vi.fn());
const conversationCreate = vi.hoisted(() => vi.fn());
const messageFindUnique = vi.hoisted(() => vi.fn());
const messageCreate = vi.hoisted(() => vi.fn());
const wabaAccountFindMany = vi.hoisted(() => vi.fn());
const wabaAccountFindFirst = vi.hoisted(() => vi.fn());
const processWebhook = vi.hoisted(() => vi.fn());
const persistInboundWebhookReceipt = vi.hoisted(() => vi.fn());
const persistStatusWebhookReceipt = vi.hoisted(() => vi.fn());
const getWabaConfig = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: {
    webhookEvent: { create: webhookEventCreate, update: webhookEventUpdate },
    contact: { upsert: contactUpsert },
    conversation: { findFirst: conversationFindFirst, create: conversationCreate },
    message: { findUnique: messageFindUnique, create: messageCreate },
    wabaAccount: { findMany: wabaAccountFindMany, findFirst: wabaAccountFindFirst },
  },
}));
vi.mock("@/lib/settings", () => ({ getWabaConfig }));
vi.mock("@/lib/whatsapp/webhook", async () => {
  const nodeCrypto = await import("node:crypto");
  return {
    processWebhook,
    // Real HMAC verification, so these assertions hold against either route
    // shape: the legacy route imported `verifySignature` via this module.
    verifySignature: (body: string, header: string | null, secret: string) => {
      if (!header || !secret) return false;
      const expected = `sha256=${nodeCrypto.createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
      return header === expected;
    },
  };
});
vi.mock("@/lib/whatsapp/inbound/receipt", () => ({ persistInboundWebhookReceipt }));
vi.mock("@/lib/whatsapp/status/receipt", () => ({ persistStatusWebhookReceipt }));
vi.mock("@/server/realtime", () => ({ publish: vi.fn(), publishGlobal: vi.fn() }));

const APP_SECRET = "route_test_app_secret";
const PHONE_NUMBER_ID = "109876543210";
const WAMID = "wamid.HBgNMTA3MTEzNTIzMTkzEgAUMwAARJ0FEXAMPLE+xyz/ABC==";

function sign(body: string, secret = APP_SECRET): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

function metaPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: "107113523193",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "15551234567", phone_number_id: PHONE_NUMBER_ID },
          contacts: [{ profile: { name: "Ada" }, wa_id: "5215550000111" }],
          messages: [{
            from: "5215550000111",
            id: WAMID,
            timestamp: "1728000000",
            type: "text",
            text: { body: "hello" },
            ...overrides,
          }],
        },
      }],
    }],
  });
}

function request(body: string, signature?: string | null): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null && signature !== undefined) headers["x-hub-signature-256"] = signature;
  return new Request("https://example.test/api/webhook", { method: "POST", body, headers });
}

async function loadPost() {
  const mod = await import("@/app/api/webhook/route");
  return mod.POST;
}

/** Business-domain writers that must stay untouched for a rejected delivery. */
function businessMutationCalls(): number {
  return (
    contactUpsert.mock.calls.length +
    conversationFindFirst.mock.calls.length +
    conversationCreate.mock.calls.length +
    messageFindUnique.mock.calls.length +
    messageCreate.mock.calls.length +
    processWebhook.mock.calls.length +
    persistInboundWebhookReceipt.mock.calls.length +
    persistStatusWebhookReceipt.mock.calls.length
  );
}

describe("POST /api/webhook — authentication is fail-closed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWabaConfig.mockResolvedValue({ appSecret: APP_SECRET, webhookVerifyToken: "verify" });
    wabaAccountFindMany.mockResolvedValue([]);
    webhookEventCreate.mockResolvedValue({ id: "evt_rejected" });
    webhookEventUpdate.mockResolvedValue({});
    processWebhook.mockResolvedValue("processed");
  });

  it("accepts a validly signed delivery and processes it", async () => {
    const body = metaPayload();
    const POST = await loadPost();
    const response = await POST(request(body, sign(body)));

    expect(response.status).toBe(200);
    expect(processWebhook).toHaveBeenCalledTimes(1);
    expect(webhookEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ signatureValid: true }),
      }),
    );
  });

  it("rejects a missing signature before any business mutation", async () => {
    const POST = await loadPost();
    const response = await POST(request(metaPayload(), null));

    expect(response.status).toBe(200); // ack so Meta stops retrying a spoofed request
    expect(businessMutationCalls()).toBe(0);
    expect(webhookEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ signatureValid: false, processedOk: false }),
      }),
    );
  });

  it("rejects an invalid signature before any business mutation", async () => {
    const body = metaPayload();
    const POST = await loadPost();
    const response = await POST(request(body, sign(body, "attacker_secret")));

    expect(response.status).toBe(200);
    expect(businessMutationCalls()).toBe(0);
  });

  it("rejects a malformed signature before any business mutation", async () => {
    const POST = await loadPost();
    for (const malformed of ["sha1=abc", "sha256=zzz", "garbage"]) {
      vi.clearAllMocks();
      getWabaConfig.mockResolvedValue({ appSecret: APP_SECRET, webhookVerifyToken: "verify" });
      wabaAccountFindMany.mockResolvedValue([]);
      webhookEventCreate.mockResolvedValue({ id: "evt_rejected" });

      const response = await POST(request(metaPayload(), malformed));
      expect(response.status).toBe(200);
      expect(businessMutationCalls()).toBe(0);
    }
  });

  it("rejects a signature valid for a tampered body", async () => {
    const body = metaPayload();
    const POST = await loadPost();
    const response = await POST(request(body + " ", sign(body)));

    expect(response.status).toBe(200);
    expect(businessMutationCalls()).toBe(0);
  });

  it("rejects when NO app secret is configured anywhere (regression: previously accepted)", async () => {
    getWabaConfig.mockResolvedValue({ appSecret: null, webhookVerifyToken: "verify" });
    wabaAccountFindMany.mockResolvedValue([]);

    const body = metaPayload();
    const POST = await loadPost();
    const response = await POST(request(body, sign(body)));

    expect(response.status).toBe(200);
    expect(businessMutationCalls()).toBe(0);
    expect(webhookEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ signatureValid: false }),
      }),
    );
  });

  it("rejects an unsigned delivery when no app secret is configured", async () => {
    getWabaConfig.mockResolvedValue({ appSecret: null, webhookVerifyToken: "verify" });
    wabaAccountFindMany.mockResolvedValue([]);

    const POST = await loadPost();
    const response = await POST(request(metaPayload(), null));

    expect(response.status).toBe(200);
    expect(businessMutationCalls()).toBe(0);
  });

  it("accepts a delivery signed with a TENANT app secret when the global one is unset", async () => {
    getWabaConfig.mockResolvedValue({ appSecret: null, webhookVerifyToken: "verify" });
    wabaAccountFindMany.mockResolvedValue([{ appSecret: "tenant_secret_value" }]);

    const body = metaPayload();
    const POST = await loadPost();
    const response = await POST(request(body, sign(body, "tenant_secret_value")));

    expect(response.status).toBe(200);
    expect(processWebhook).toHaveBeenCalledTimes(1);
  });

  it("records bounded structured diagnostics on rejection", async () => {
    const POST = await loadPost();
    await POST(request(metaPayload(), null));

    expect(webhookEventUpdate).toHaveBeenCalledTimes(1);
    const update = webhookEventUpdate.mock.calls[0][0] as { data: { error: string; eventSummary: string } };
    const diagnostic = JSON.parse(update.data.error) as Record<string, string>;

    expect(diagnostic.stage).toBe("webhook.authentication");
    expect(diagnostic.category).toBe("AUTH_REJECTED");
    expect(diagnostic.reason).toBe("SIGNATURE_MISSING");
    expect(diagnostic.correlationId).toBe("evt_rejected");
    expect(update.data.eventSummary).toMatch(/^rejected: /);
  });

  it("never persists secret or signature material in the rejection row", async () => {
    const body = metaPayload();
    const POST = await loadPost();
    await POST(request(body, sign(body, "attacker_secret")));

    const persisted = JSON.stringify({
      create: webhookEventCreate.mock.calls,
      update: webhookEventUpdate.mock.calls,
    });

    expect(persisted).not.toContain(APP_SECRET);
    expect(persisted).not.toContain("attacker_secret");
    expect(persisted).not.toContain(sign(body, "attacker_secret").replace("sha256=", ""));
  });

  it("records structured diagnostics when processing throws", async () => {
    processWebhook.mockRejectedValue(new Error("Unable to resolve inbound phone number X to a tenant (found 0 records)"));

    const POST = await loadPost();
    webhookEventCreate.mockResolvedValue({ id: "evt_proc" });
    const response = await POST(request(metaPayload(), sign(metaPayload())));

    expect(response.status).toBe(200);
    const update = webhookEventUpdate.mock.calls.at(-1)![0] as { data: { error: string } };
    const diagnostic = JSON.parse(update.data.error) as Record<string, string>;

    expect(diagnostic.stage).toBe("inbound.processing");
    expect(diagnostic.category).toBe("TENANT_UNRESOLVED");
    expect(diagnostic.correlationId).toBe("evt_proc");
  });

  it("marks the event processed with no error on success", async () => {
    webhookEventCreate.mockResolvedValue({ id: "evt_ok" });
    const POST = await loadPost();
    await POST(request(metaPayload(), sign(metaPayload())));

    const update = webhookEventUpdate.mock.calls.at(-1)![0] as { data: Record<string, unknown> };
    expect(update.data.processedOk).toBe(true);
    expect(update.data.error).toBeNull();
  });
});

describe("GET /api/webhook — verification handshake unchanged", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWabaConfig.mockResolvedValue({ appSecret: APP_SECRET, webhookVerifyToken: "verify" });
    wabaAccountFindFirst.mockResolvedValue(null);
  });

  it("echoes the challenge for a matching global verify token", async () => {
    const { GET } = await import("@/app/api/webhook/route");
    const response = await GET(new Request(
      "https://example.test/api/webhook?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=12345",
    ));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("12345");
  });

  it("echoes the challenge for a matching tenant verify token", async () => {
    wabaAccountFindFirst.mockResolvedValue({ id: "waba_tenant" });
    const { GET } = await import("@/app/api/webhook/route");
    const response = await GET(new Request(
      "https://example.test/api/webhook?hub.mode=subscribe&hub.verify_token=tenant_token&hub.challenge=999",
    ));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("999");
  });

  it("refuses an unknown verify token", async () => {
    const { GET } = await import("@/app/api/webhook/route");
    const response = await GET(new Request(
      "https://example.test/api/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1",
    ));

    expect(response.status).toBe(403);
  });
});
