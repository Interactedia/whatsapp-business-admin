import { beforeEach, describe, expect, it, vi } from "vitest";

const trustedContexts = new WeakSet<object>();
const membershipFindUnique = vi.hoisted(() => vi.fn());
const phoneFindFirst = vi.hoisted(() => vi.fn());
const phoneFindMany = vi.hoisted(() => vi.fn());
const wabaFindFirst = vi.hoisted(() => vi.fn());
const conversationFindUnique = vi.hoisted(() => vi.fn());
const contactFindFirst = vi.hoisted(() => vi.fn());
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
    conversation: { findUnique: conversationFindUnique, create: conversationCreate, update: conversationUpdate },
    contact: { findFirst: contactFindFirst },
    message: { create: messageCreate, update: messageUpdate },
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
vi.mock("@/lib/whatsapp/webhook", () => ({ serializeMessage: (message: unknown) => message }));

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

  it("rejects ambiguous inbound business phone metadata", async () => {
    const { resolveInboundPhoneNumber } = await import("@/lib/tenant/waba");
    phoneFindMany.mockResolvedValueOnce([ownedPhone, { ...ownedPhone, id: "phone-2" }]);
    await expect(resolveInboundPhoneNumber("meta-phone-1")).rejects.toThrow("Tenant access denied");
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
