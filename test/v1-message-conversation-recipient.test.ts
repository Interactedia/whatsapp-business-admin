import { beforeEach, describe, expect, it, vi } from "vitest";

const conversationFindFirst = vi.hoisted(() => vi.fn());
const conversationFindUnique = vi.hoisted(() => vi.fn());
const contactFindFirst = vi.hoisted(() => vi.fn());
const phoneNumberFindFirst = vi.hoisted(() => vi.fn());
const templateFindFirst = vi.hoisted(() => vi.fn());
const startTenantConversation = vi.hoisted(() => vi.fn());
const sendMessage = vi.hoisted(() => vi.fn());
const storeFromLink = vi.hoisted(() => vi.fn());
const computeIdempotencyFingerprint = vi.hoisted(() => vi.fn(() => "fingerprint"));
const runIdempotent = vi.hoisted(() => vi.fn(async (_binding, execute) => execute()));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: { findFirst: conversationFindFirst, findUnique: conversationFindUnique },
    contact: { findFirst: contactFindFirst },
    phoneNumber: { findFirst: phoneNumberFindFirst },
    template: { findFirst: templateFindFirst },
  },
}));
vi.mock("@/lib/tenant", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tenant")>("@/lib/tenant");
  return {
    ...actual,
    resolveApiKeyTenantContext: vi.fn(async () => ({ tenantId: "tenant-1", userId: "key-1", membershipId: "api-key:key-1" })),
  };
});
vi.mock("@/lib/tenant/conversations", () => ({ startTenantConversation }));
vi.mock("@/lib/whatsapp/send", () => ({
  sendMessage,
  enqueueOutboundMessage: vi.fn(),
  isWithinSessionWindow: vi.fn(() => true),
}));
vi.mock("@/lib/whatsapp/media", () => ({ storeFromLink }));
vi.mock("@/lib/whatsapp/outbound/config", () => ({ isOutboundAsyncEnabled: vi.fn(() => false) }));
vi.mock("@/lib/whatsapp/flow-launch", () => ({
  prepareTemplateFlowLaunch: vi.fn(async () => null),
  finishPreparedFlowLaunch: vi.fn(),
}));
vi.mock("@/lib/idempotency", () => ({
  parseIdempotencyKey: vi.fn((request: Request) => request.headers.get("idempotency-key")),
  computeIdempotencyFingerprint,
  runIdempotent,
}));
vi.mock("@/lib/v1", async () => {
  const actual = await vi.importActual<typeof import("@/lib/v1")>("@/lib/v1");
  return {
    ...actual,
    requireApiKey: vi.fn(async () => ({ apiKeyId: "key-1", userId: null, tenantId: "tenant-1" })),
  };
});

const recipient = {
  id: "conversation-1",
  contactId: "contact-1",
  contact: { waId: "15551234567" },
  phoneNumber: { id: "phone-1", metaPhoneNumberId: "meta-phone-1" },
};

function request(body: unknown, idempotencyKey?: string) {
  return new Request("http://localhost/api/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
    body: JSON.stringify(body),
  });
}

async function post(body: unknown, idempotencyKey?: string) {
  const { POST } = await import("@/app/api/v1/messages/route");
  return POST(request(body, idempotencyKey), { params: Promise.resolve({}) });
}

describe("POST /api/v1/messages conversation recipient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    conversationFindFirst.mockResolvedValue(recipient);
    conversationFindUnique.mockResolvedValue({ lastMessageAt: new Date() });
    contactFindFirst.mockResolvedValue(null);
    phoneNumberFindFirst.mockResolvedValue(recipient.phoneNumber);
    templateFindFirst.mockResolvedValue({ name: "welcome", language: "en_US", category: "UTILITY", components: [] });
    startTenantConversation.mockResolvedValue({ id: "conversation-1" });
    sendMessage.mockResolvedValue({ id: "message-1", waMessageId: "wamid-1" });
  });

  it.each([
    [{ type: "text", text: "hello" }, { kind: "text", text: "hello" }],
    [{ type: "image", media: { id: "media-1", caption: "photo" } }, { kind: "media", mediaType: "image", mediaId: "media-1", mediaLink: undefined, mediaPath: undefined, mediaMime: undefined, caption: "photo", filename: undefined }],
  ])("routes conversation text/media through the existing send pipeline", async (payload, content) => {
    const response = await post({ conversationId: "conversation-1", ...payload });

    expect(response.status).toBe(201);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conversation-1",
      to: "15551234567",
      content,
    }));
    expect(await response.json()).toEqual({ status: "success", message_id: "wamid-1", id: "message-1" });
    expect(startTenantConversation).not.toHaveBeenCalled();
    expect(contactFindFirst).not.toHaveBeenCalled();
  });

  it("routes conversation templates through the existing send pipeline", async () => {
    const response = await post({ conversationId: "conversation-1", type: "template", template: "welcome", language: "en_US" });

    expect(response.status).toBe(201);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conversation-1",
      to: "15551234567",
      content: expect.objectContaining({ kind: "template", templateName: "welcome", language: "en_US" }),
    }));
    expect((await response.json()).to).toBeUndefined();
    expect(startTenantConversation).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { to: "15551234567", conversationId: "conversation-1", type: "text", text: "hello" },
  ])("requires exactly one recipient selector", async (body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(conversationFindFirst).not.toHaveBeenCalled();
  });

  it.each([null, undefined])("returns the same tenant-scoped 404 without side effects", async (result) => {
    conversationFindFirst.mockResolvedValue(result);
    const response = await post({ conversationId: "missing", type: "image", media: { link: "https://example.test/a.jpg" } });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: "Recipient not found" });
    expect(conversationFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: "missing",
      tenantId: "tenant-1",
      contact: { tenantId: "tenant-1" },
      phoneNumber: { wabaAccount: { tenantId: "tenant-1" } },
    } }));
    expect(storeFromLink).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(startTenantConversation).not.toHaveBeenCalled();
  });

  it("uses canonical effective routing inputs and removes recipient PII from duplicate responses", async () => {
    runIdempotent.mockImplementationOnce(async () => new Response(JSON.stringify({ id: "message-1", to: "15551234567", duplicate: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const response = await post({ conversationId: "conversation-1", type: "text", text: "hello" }, "same-key");

    expect(computeIdempotencyFingerprint).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1",
      phoneNumberId: "phone-1",
      conversationId: "conversation-1",
      to: "15551234567",
      type: "text",
      text: "hello",
    }));
    expect(await response.json()).toEqual({ status: "success", id: "message-1", duplicate: true });
  });

  it("preserves legacy creation and response shape", async () => {
    contactFindFirst.mockResolvedValue({ conversations: [{ id: "conversation-1", phoneNumberId: "phone-1" }] });
    const response = await post({ to: "15551234567", type: "text", text: "hello" });

    expect(startTenantConversation).toHaveBeenCalledWith(expect.objectContaining({ waId: "15551234567", phoneNumberId: "phone-1" }));
    expect(await response.json()).toEqual({ status: "success", message_id: "wamid-1", id: "message-1", to: "15551234567" });
  });
});
