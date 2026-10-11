import { beforeEach, describe, expect, it, vi } from "vitest";

const trustedContexts = new WeakSet<object>();
const membershipFindUnique = vi.hoisted(() => vi.fn());
const phoneFindFirst = vi.hoisted(() => vi.fn());
const phoneFindMany = vi.hoisted(() => vi.fn());
const wabaFindFirst = vi.hoisted(() => vi.fn());
const conversationFindUnique = vi.hoisted(() => vi.fn());
const contactFindUnique = vi.hoisted(() => vi.fn());
const contactUpdate = vi.hoisted(() => vi.fn());
const contactUpsert = vi.hoisted(() => vi.fn());
const contactCreate = vi.hoisted(() => vi.fn());
const conversationCreate = vi.hoisted(() => vi.fn());
const messageCreate = vi.hoisted(() => vi.fn());
const messageUpdate = vi.hoisted(() => vi.fn());
const conversationUpdate = vi.hoisted(() => vi.fn());
const templateFindUnique = vi.hoisted(() => vi.fn());
const apiLogCreate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMembership: { findUnique: membershipFindUnique },
    phoneNumber: { findFirst: phoneFindFirst, findMany: phoneFindMany },
    wabaAccount: { findFirst: wabaFindFirst },
    wabaSettings: { findUnique: vi.fn().mockResolvedValue({}) },
    conversation: { findUnique: conversationFindUnique, create: conversationCreate, update: conversationUpdate },
    contact: { findFirst: vi.fn(), findUnique: contactFindUnique, update: contactUpdate, create: contactCreate, upsert: contactUpsert },
    message: { findUnique: vi.fn(), create: messageCreate, update: messageUpdate },
    template: { findUnique: templateFindUnique },
    apiLog: { create: apiLogCreate },
  },
}));

vi.mock("@/lib/tenant", () => ({
  TenantAuthorizationError: class TenantAuthorizationError extends Error {
    constructor(message = "Tenant access denied") {
      super(message);
      this.name = "TenantAuthorizationError";
    }
  },
  assertTrustedTenantContext: (context: object) => {
    if (!trustedContexts.has(context)) throw new Error("Tenant access denied");
  },
}));
vi.mock("@/lib/crypto", () => ({ decrypt: (value: string) => `plain:${value}`, encrypt: (value: string) => `enc:${value}` }));
vi.mock("@/server/realtime", () => ({ publish: vi.fn() }));
vi.mock("@/lib/whatsapp/webhook", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/whatsapp/webhook")>();
  return { ...actual, serializeMessage: (message: unknown) => message };
});

const context = { tenantId: "tenant-1", userId: "user-1", membershipId: "membership-1" };
trustedContexts.add(context);
const ownedPhone = {
  id: "phone-1",
  metaPhoneNumberId: "meta-phone-1",
  displayPhone: "+1",
  verifiedName: "Support",
  wabaAccount: {
    id: "waba-1",
    tenantId: "tenant-1",
    metaWabaId: "meta-waba-1",
    name: "Main WABA",
    metaAppId: "app-1",
    accessTokenEnc: "token-1",
    appSecret: "secret-1",
    apiVersion: "v21.0",
  },
};

describe("tenant-owned WABA/PhoneNumber routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200 })) as typeof fetch;
    apiLogCreate.mockResolvedValue({});
    conversationUpdate.mockResolvedValue({});
    messageUpdate.mockResolvedValue({ id: "message-1", status: "SENT" });
    messageCreate.mockResolvedValue({ id: "message-1" });
  });

  it("resolves tenant-owned phone numbers and rejects foreign phones", async () => {
    const { resolveTenantPhoneNumber } = await import("@/lib/tenant/waba");
    phoneFindFirst.mockResolvedValueOnce(ownedPhone);
    await expect(resolveTenantPhoneNumber(context, "phone-1")).resolves.toMatchObject({ id: "phone-1" });
    expect(phoneFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "phone-1", wabaAccount: { tenantId: "tenant-1" } },
    }));

    phoneFindFirst.mockResolvedValueOnce(null);
    await expect(resolveTenantPhoneNumber(context, "foreign-phone")).rejects.toThrow("Tenant access denied");
  });

  it("requires explicit authorized phoneNumberId for new conversations (no implicit default)", async () => {
    const { createTenantConversation, startTenantConversation } = await import("@/lib/tenant/conversations");

    // Simulating foreign or missing number throws TenantAuthorizationError (handled by resolveTenantPhoneNumber returning null)
    phoneFindFirst.mockResolvedValueOnce(null);
    await expect(
      createTenantConversation({ context, contactId: "contact-1", phoneNumberId: "missing-or-foreign" })
    ).rejects.toThrow("Tenant access denied");

    // Success case
    phoneFindFirst.mockResolvedValueOnce(ownedPhone);
    const existingContact = { id: "contact-1", tenantId: "tenant-1" };
    contactFindUnique.mockResolvedValueOnce(null);
    contactCreate.mockResolvedValueOnce(existingContact);
    conversationFindUnique.mockResolvedValueOnce(null);
    conversationCreate.mockResolvedValueOnce({ id: "conv-1" });

    await expect(
      startTenantConversation({ context, waId: "919812345678", phoneNumberId: "phone-1" })
    ).resolves.toMatchObject({ id: "conv-1" });
  });

  it("inbound webhook binding: known -> succeeds, foreign/unknown/ambiguous -> rejected", async () => {
    const { resolveInboundPhoneNumber } = await import("@/lib/tenant/waba");

    // Known exactly one -> succeeds
    phoneFindMany.mockResolvedValueOnce([ownedPhone]);
    await expect(resolveInboundPhoneNumber("meta-phone-1")).resolves.toEqual(ownedPhone);

    // Foreign / Unknown (zero results) -> rejected (TenantAuthorizationError
    // is thrown by resolveInboundPhoneNumber with a descriptive message after
    // the lazy-provision fallback also returns no match).
    phoneFindMany.mockResolvedValueOnce([]);
    await expect(resolveInboundPhoneNumber("meta-unknown")).rejects.toThrow(
      /resolve inbound phone number meta-unknown/,
    );

    // Ambiguous (multiple results) -> rejected
    phoneFindMany.mockResolvedValueOnce([ownedPhone, { ...ownedPhone, id: "phone-2" }]);
    await expect(resolveInboundPhoneNumber("meta-ambiguous")).rejects.toThrow(
      /resolve inbound phone number meta-ambiguous/,
    );
  });

  it("cross-tenant credential isolation: prevents using another tenant's credentials", async () => {
    const { resolveTenantPhoneNumber } = await import("@/lib/tenant/waba");
    phoneFindFirst.mockResolvedValueOnce(null); // prisma query enforces wabaAccount: { tenantId: context.tenantId }
    await expect(resolveTenantPhoneNumber(context, "foreign-phone-id")).rejects.toThrow("Tenant access denied");
  });

  it("historical unbound conversations and existing bound conflicts fail correctly on inbound", async () => {
    const { processWebhook } = await import("@/lib/whatsapp/webhook");
    const payload = {
      entry: [{
        changes: [{
          field: "messages",
          value: {
            metadata: { display_phone_number: "1", phone_number_id: "meta-phone-1" },
            contacts: [{ wa_id: "919812345678", profile: { name: "User" } }],
            messages: [{ from: "919812345678", timestamp: "1600000000", id: "wamid.in", type: "text", text: { body: "hi" } }]
          }
        }]
      }]
    };

    // 1. Existing unbound conversation fails closed if we try to rebind silently.
    phoneFindMany.mockResolvedValueOnce([ownedPhone]);
    contactUpsert.mockResolvedValueOnce({ id: "contact-1", tenantId: "tenant-1" });
    conversationFindUnique.mockResolvedValueOnce({ id: "conv-hist", phoneNumberId: null });

    await expect(processWebhook(payload)).rejects.toThrow("Inbound conversation is unbound");

    // 2. Conflicting existing binding fails closed
    phoneFindMany.mockResolvedValueOnce([ownedPhone]);
    contactUpsert.mockResolvedValueOnce({ id: "contact-1", tenantId: "tenant-1" });
    conversationFindUnique.mockResolvedValueOnce({ id: "conv-hist", phoneNumberId: "different-phone-id" });

    await expect(processWebhook(payload)).rejects.toThrow("Inbound conversation sender mismatch");
  });

  it("fails closed for unbound conversations before provider invocation", async () => {
    const { sendMessage } = await import("@/lib/whatsapp/send");
    conversationFindUnique.mockResolvedValueOnce({ id: "conversation-1", tenantId: "tenant-1", phoneNumber: null });

    await expect(sendMessage({ conversationId: "conversation-1", to: "15551234567", content: { kind: "text", text: "hi" } }))
      .rejects.toThrow("Conversation has no authorized sender phone number");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(messageCreate).not.toHaveBeenCalled();
  });

  it("uses the bound phone credentials for provider routing", async () => {
    const { sendMessage } = await import("@/lib/whatsapp/send");
    conversationFindUnique.mockResolvedValueOnce({ id: "conversation-1", tenantId: "tenant-1", phoneNumber: ownedPhone });

    await sendMessage({ conversationId: "conversation-1", to: "15551234567", content: { kind: "text", text: "hi" } });

    expect(global.fetch).toHaveBeenCalledWith(
      "https://graph.facebook.com/v21.0/meta-phone-1/messages",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer plain:token-1" }) }),
    );
    expect(messageCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tenantId: "tenant-1", status: "PENDING" }),
    }));
  });
});
