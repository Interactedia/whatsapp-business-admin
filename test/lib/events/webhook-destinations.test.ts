import { describe, expect, it, vi } from "vitest";
import { EXTERNAL_EVENT_TYPES } from "@/lib/events/contract";
import { signWebhookBody, verifyWebhookSignature, webhookDestinationInputSchema } from "@/lib/events/webhook-destinations";

const encrypt = vi.hoisted(() => vi.fn((value: string) => `enc:${value}`));
const decrypt = vi.hoisted(() => vi.fn((value: string) => value.replace(/^enc:/, "")));
const create = vi.hoisted(() => vi.fn());
const findFirst = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());

vi.mock("@/lib/crypto", () => ({ encrypt, decrypt }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    webhookDestination: { create, findFirst, update },
    canonicalEventDelivery: { findMany: vi.fn() },
  },
}));

describe("webhook destination validation and signing", () => {
  it("accepts only supported canonical event subscriptions", () => {
    expect(webhookDestinationInputSchema.parse({
      name: "n8n",
      endpointUrl: "https://hooks.example.test/wba",
      subscriptions: Object.values(EXTERNAL_EVENT_TYPES),
    }).subscriptions).toHaveLength(4);

    expect(() => webhookDestinationInputSchema.parse({
      name: "bad",
      endpointUrl: "https://hooks.example.test/wba",
      subscriptions: ["custom.event"],
    })).toThrow();
  });

  it("rejects non-HTTPS configuration URLs", () => {
    expect(() => webhookDestinationInputSchema.parse({
      name: "bad",
      endpointUrl: "http://hooks.example.test/wba",
      subscriptions: [EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED],
    })).toThrow();
  });

  it("detects signature tampering and replay timestamps", () => {
    const body = JSON.stringify({ ok: true });
    const signed = signWebhookBody(body, "secret", Math.floor(Date.now() / 1000));
    expect(verifyWebhookSignature(body, "secret", signed.timestamp, signed.signature)).toBe(true);
    expect(verifyWebhookSignature(`${body} `, "secret", signed.timestamp, signed.signature)).toBe(false);
    expect(verifyWebhookSignature(body, "secret", "1", signed.signature)).toBe(false);
  });
});

describe("webhook destination repository", () => {
  it("stores encrypted secrets and returns plaintext only on create", async () => {
    create.mockResolvedValueOnce({
      id: "dest_1",
      tenantId: "tenant_1",
      name: "Mastra",
      endpointUrl: "https://hooks.example.test/wba",
      enabled: true,
      retiredAt: null,
      subscriptions: [EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED],
      secretVersion: 1,
      lastTestAt: null,
      createdAt: new Date("2026-10-12T00:00:00.000Z"),
      updatedAt: new Date("2026-10-12T00:00:00.000Z"),
    });
    const { createWebhookDestination } = await import("@/lib/events/webhook-destinations");
    const result = await createWebhookDestination("tenant_1", {
      name: "Mastra",
      endpointUrl: "https://hooks.example.test/wba",
      subscriptions: [EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED],
    });

    expect(encrypt).toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tenantId: "tenant_1", signingSecretEnc: expect.stringMatching(/^enc:/) }),
    }));
    expect(result.destination).not.toHaveProperty("signingSecretEnc");
    expect(result.signingSecret).toEqual(expect.any(String));
  });

  it("keeps destination identity stable when URL changes", async () => {
    findFirst.mockResolvedValueOnce({ id: "dest_1", retiredAt: null });
    update.mockResolvedValueOnce({
      id: "dest_1",
      tenantId: "tenant_1",
      name: "Mastra",
      endpointUrl: "https://new.example.test/wba",
      enabled: true,
      retiredAt: null,
      subscriptions: [EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED],
      secretVersion: 1,
      lastTestAt: null,
      createdAt: new Date("2026-10-12T00:00:00.000Z"),
      updatedAt: new Date("2026-10-12T00:01:00.000Z"),
    });
    const { updateWebhookDestination } = await import("@/lib/events/webhook-destinations");
    const result = await updateWebhookDestination("tenant_1", "dest_1", { endpointUrl: "https://new.example.test/wba" });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "dest_1" }, data: { endpointUrl: "https://new.example.test/wba" } }));
    expect(result?.id).toBe("dest_1");
  });

  it("does not select disabled or retired destinations for dispatch", async () => {
    findFirst.mockResolvedValueOnce(null);
    const { destinationForDispatch } = await import("@/lib/events/webhook-destinations");
    await expect(destinationForDispatch("tenant_1", "dest_1")).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant_1", id: "dest_1", enabled: true, retiredAt: null } }));
  });
});
