import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTemplateContent } from "@/lib/whatsapp/template-content";

const mocks = vi.hoisted(() => ({
  template: { findMany: vi.fn(), findUnique: vi.fn() },
  apiLog: { findMany: vi.fn() },
  message: { create: vi.fn(), update: vi.fn() },
  conversation: { findUnique: vi.fn(), update: vi.fn() },
  graphFetch: vi.fn(), publish: vi.fn(), storeFromLink: vi.fn(), downloadInboundMedia: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: mocks }));
vi.mock("@/lib/settings", () => ({ getWabaConfig: vi.fn(async () => ({ phoneNumberId: "123" })) }));
vi.mock("@/lib/crypto", () => ({ decrypt: (value: string) => value, encrypt: (value: string) => value }));
vi.mock("@/server/realtime", () => ({ publish: mocks.publish }));
vi.mock("@/lib/whatsapp/client", () => ({ graphFetch: mocks.graphFetch, WhatsAppApiError: class extends Error {} }));
vi.mock("@/lib/whatsapp/media", () => ({ storeFromLink: mocks.storeFromLink, downloadInboundMedia: mocks.downloadInboundMedia }));

import { resolveTemplateContents } from "@/lib/whatsapp/template-history";
import { resolveTemplateMedia } from "@/lib/whatsapp/template-media";
import { sendMessage, type OutboundContent } from "@/lib/whatsapp/send";
import { serializeMessage } from "@/lib/whatsapp/webhook";

const definition = [{ type: "BODY", text: "Hello {{1}}", example: { body_text: [["SAMPLE"]] } }];
const parameters = [{ type: "body", parameters: [{ type: "text", text: "Priya" }] }];
const template = { id: "t1", name: "welcome", language: "en", components: definition };
const message = {
  id: "m1", conversationId: "c1", type: "TEMPLATE", templateId: "t1", payload: null as unknown,
  text: "Template: welcome", waMessageId: "wamid.1", direction: "OUT", status: "SENT", caption: null,
  mediaPath: null, mediaMime: null, mediaFilename: null, timestamp: new Date(),
};
const log = {
  relatedId: "m1", ok: true,
  requestBody: { type: "template", template: { name: "welcome", language: { code: "en" }, components: parameters } },
  responseBody: { messages: [{ id: "wamid.1" }] },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.template.findMany.mockResolvedValue([template]);
  mocks.template.findUnique.mockResolvedValue(template);
  mocks.apiLog.findMany.mockResolvedValue([log]);
  mocks.graphFetch.mockResolvedValue({ messages: [{ id: "wamid.1" }] });
  mocks.conversation.findUnique.mockResolvedValue({
    id: "c1",
    tenantId: "tenant-1",
    phoneNumber: {
      id: "phone-1",
      metaPhoneNumberId: "123",
      displayPhone: null,
      verifiedName: null,
      wabaAccount: { id: "waba-1", tenantId: "tenant-1", metaWabaId: "waba-1", accessTokenEnc: "token", apiVersion: "v21.0" },
    },
  });
  mocks.conversation.update.mockResolvedValue({});
});

describe("historical templates", () => {
  it("reconstructs actual values with batch queries and does not rewrite history", async () => {
    const contents = await resolveTemplateContents([message, { ...message, id: "m2" }]);
    expect(contents.get("m1")).toMatchObject({ body: "Hello Priya", source: "reconstructed", missingValues: false });
    expect(contents.get("m2")).toMatchObject({ body: "Hello {{1}}", missingValues: true });
    expect(mocks.template.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.apiLog.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.message.update).not.toHaveBeenCalled();
  });

  it("uses the matching WhatsApp message ID over another successful attempt", async () => {
    mocks.apiLog.findMany.mockResolvedValue([{ ...log, responseBody: { messages: [{ id: "different" }] }, requestBody: { ...log.requestBody, template: { ...log.requestBody.template, components: [] } } }, log]);
    expect((await resolveTemplateContents([message])).get("m1")?.body).toBe("Hello Priya");
  });

  it.each([{ logs: [] }, { logs: [{ ...log, requestBody: { ...log.requestBody, template: { ...log.requestBody.template, components: ["[REDACTED FLOW PARAMETERS]"] } } }] }])("leaves unavailable sent values unresolved", async ({ logs }) => {
    mocks.apiLog.findMany.mockResolvedValue(logs);
    expect((await resolveTemplateContents([message])).get("m1")).toMatchObject({ body: "Hello {{1}}", missingValues: true });
  });

  it("uses exact logged name and language if the relation was deleted", async () => {
    mocks.template.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([template]);
    const contents = await resolveTemplateContents([{ ...message, templateId: null }]);
    expect(contents.get("m1")?.body).toBe("Hello Priya");
    expect(mocks.template.findMany).toHaveBeenLastCalledWith({ where: { OR: [{ name: "welcome", language: "en" }] } });
  });

  it("shows unavailable content when the definition has gone", async () => {
    mocks.template.findMany.mockResolvedValue([]);
    expect((await resolveTemplateContents([message])).get("m1")).toMatchObject({ source: "unavailable", name: "welcome" });
  });

  it("keeps saved wording and values after template changes or deletion without reading logs", async () => {
    const snapshot = buildTemplateContent({ name: "welcome", language: "en", definition, parameters });
    mocks.template.findMany.mockResolvedValue([]);
    const contents = await resolveTemplateContents([{ ...message, templateId: null, payload: { templateContent: snapshot } }]);
    expect(contents.get("m1")).toEqual(snapshot);
    expect(mocks.template.findMany).not.toHaveBeenCalled();
    expect(mocks.apiLog.findMany).not.toHaveBeenCalled();
  });
});

describe("template delivery persistence and serialization", () => {
  function mockPersistence() {
    let row = { ...message };
    mocks.message.create.mockImplementation(async ({ data }) => { row = { ...row, ...data }; return row; });
    mocks.message.update.mockImplementation(async ({ data }) => { row = { ...row, ...data }; return row; });
    return () => row;
  }
  const content: OutboundContent = { kind: "template", templateId: "t1", templateName: "welcome", language: "en", templateComponents: definition, components: parameters };

  it("saves full content before sending and publishes it with a short preview", async () => {
    mockPersistence();
    const result = await sendMessage({ conversationId: "c1", to: "919999999999", content });
    expect(result.text).toBe("Hello Priya");
    expect(serializeMessage(result).templateContent?.body).toBe("Hello Priya");
    expect(mocks.message.create.mock.invocationCallOrder[0]).toBeLessThan(mocks.graphFetch.mock.invocationCallOrder[0]);
    expect(mocks.conversation.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { lastMessageAt: expect.any(Date), lastPreview: "Hello Priya" } });
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ message: expect.objectContaining({ templateContent: expect.objectContaining({ body: "Hello Priya" }) }) }) }), "tenant-1");
    expect(mocks.graphFetch).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ template: { name: "welcome", language: { code: "en" }, components: parameters } }) }));
  });

  it("retains content when delivery fails and leaves the conversation preview unchanged", async () => {
    const row = mockPersistence();
    mocks.graphFetch.mockRejectedValue(new Error("Meta rejected message"));
    await expect(sendMessage({ conversationId: "c1", to: "919999999999", content })).rejects.toThrow("Meta rejected message");
    expect(row()).toMatchObject({ status: "FAILED", text: "Hello Priya", payload: { templateContent: { body: "Hello Priya" } } });
    expect(mocks.conversation.update).not.toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ message: expect.objectContaining({ status: "FAILED", templateContent: expect.objectContaining({ body: "Hello Priya" }) }) }) }), "tenant-1");
  });

  it("resolves definitions for callers supplying only template identity", async () => {
    mockPersistence();
    await sendMessage({ conversationId: "c1", to: "919999999999", content: { ...content, templateComponents: undefined, preview: "Broadcast: campaign" } });
    expect(mocks.template.findUnique).toHaveBeenCalled();
    expect(mocks.message.create).toHaveBeenCalledWith({ data: expect.objectContaining({ text: "Hello Priya" }) });
  });

  it("never serializes raw Flow action payloads or unknown snapshot fields", () => {
    const snapshot = buildTemplateContent({ name: "welcome", language: "en", definition, parameters });
    const serialized = serializeMessage({ ...message, payload: { templateContent: { ...snapshot, flow_token: "secret" }, action: { flow_token: "secret" } } });
    expect(JSON.stringify(serialized)).not.toContain("secret");
    expect(serializeMessage({ ...message, type: "TEXT", text: "Hi" }).text).toBe("Hi");
    expect(serializeMessage({ ...message, type: "TEXT" }).templateContent).toBeUndefined();
  });
});

describe("template media", () => {
  const withMedia = (type: string, source: object) => ({ ...message, payload: { templateContent: buildTemplateContent({
    name: "welcome", language: "en", definition: [{ type: "HEADER", format: type.toUpperCase() }, ...definition],
    parameters: [{ type: "header", parameters: [{ type, [type]: source }] }, ...parameters],
  }) } });

  it.each(["image", "video", "document"])("downloads %s by link on demand and saves it", async (type) => {
    const mime = type === "image" ? "image/png" : type === "video" ? "video/mp4" : "application/pdf";
    mocks.storeFromLink.mockResolvedValue({ path: "stored/file", mime });
    mocks.message.update.mockImplementation(async ({ data }) => ({ ...message, ...data }));
    expect(await resolveTemplateMedia(withMedia(type, { link: "https://example.test/media", filename: "file" }))).toMatchObject({ mediaPath: "stored/file", mediaMime: mime });
    expect(mocks.storeFromLink).toHaveBeenCalledWith("https://example.test/media");
  });

  it("retrieves a Meta media ID and reuses local files", async () => {
    mocks.downloadInboundMedia.mockResolvedValue({ path: "stored/image", mime: "image/png" });
    mocks.message.update.mockImplementation(async ({ data }) => ({ ...message, ...data }));
    const resolved = await resolveTemplateMedia(withMedia("image", { id: "123" }));
    expect(mocks.downloadInboundMedia).toHaveBeenCalledWith("123");
    await resolveTemplateMedia(resolved);
    expect(mocks.downloadInboundMedia).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent media requests", async () => {
    mocks.storeFromLink.mockResolvedValue({ path: "stored/image", mime: "image/png" });
    mocks.message.update.mockImplementation(async ({ data }) => ({ ...message, ...data }));
    const input = withMedia("image", { link: "https://example.test/image" });
    await Promise.all([resolveTemplateMedia(input), resolveTemplateMedia(input)]);
    expect(mocks.storeFromLink).toHaveBeenCalledTimes(1);
  });

  it("handles expired media without changing the message or throwing", async () => {
    mocks.downloadInboundMedia.mockRejectedValue(new Error("Expired"));
    const input = withMedia("image", { id: "123" });
    expect(await resolveTemplateMedia(input)).toEqual(input);
    expect(mocks.message.update).not.toHaveBeenCalled();
  });

  it("does not fetch missing sources, invalid IDs, or non-HTTP links", async () => {
    for (const source of [{}, { id: "../secret" }, { link: "file:///secret" }]) await resolveTemplateMedia(withMedia("image", source));
    expect(mocks.downloadInboundMedia).not.toHaveBeenCalled();
    expect(mocks.storeFromLink).not.toHaveBeenCalled();
  });
});
