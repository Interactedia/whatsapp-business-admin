import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXTERNAL_EVENT_TYPES } from "@/lib/events/contract";
import { signWebhookBody, verifyWebhookSignature, webhookDestinationInputSchema } from "@/lib/events/webhook-destinations";

const encrypt = vi.hoisted(() => vi.fn((value: string) => `enc:${value}`));
const decrypt = vi.hoisted(() => vi.fn((value: string) => value.replace(/^enc:/, "")));
const create = vi.hoisted(() => vi.fn());
const findFirst = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() => vi.fn());
const suspendDeliveriesForDestination = vi.hoisted(() => vi.fn().mockResolvedValue(3));
const resumeDeliveriesForDestination = vi.hoisted(() => vi.fn().mockResolvedValue(3));

vi.mock("@/lib/crypto", () => ({ encrypt, decrypt }));
vi.mock("@/lib/events/delivery-state", () => ({
  suspendDeliveriesForDestination,
  resumeDeliveriesForDestination,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    webhookDestination: { create, findFirst, update },
    canonicalEventDelivery: { findMany: vi.fn() },
    $transaction: transaction,
  },
}));

const destinationRow = (overrides: Record<string, unknown> = {}) => ({
  id: "dest_1",
  tenantId: "tenant_1",
  name: "Mastra",
  endpointUrl: "https://new.example.test/wba",
  enabled: true,
  retiredAt: null,
  subscriptions: [EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED],
  secretVersion: 1,
  lastTestAt: null,
  deliverySuspensionUrl: null,
  createdAt: new Date("2026-10-12T00:00:00.000Z"),
  updatedAt: new Date("2026-10-12T00:01:00.000Z"),
  ...overrides,
});

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
  beforeEach(() => {
    vi.clearAllMocks();
    suspendDeliveriesForDestination.mockResolvedValue(3);
    resumeDeliveriesForDestination.mockResolvedValue(3);
    transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({ webhookDestination: { update, findFirst } }),
    );
  });

  it("stores encrypted secrets and returns plaintext only on create", async () => {
    create.mockResolvedValueOnce(destinationRow({ deliverySuspensionUrl: null }));
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
    findFirst.mockResolvedValueOnce({ id: "dest_1", endpointUrl: "https://old.example.test/wba", retiredAt: null });
    update.mockResolvedValueOnce(destinationRow());
    const { updateWebhookDestination } = await import("@/lib/events/webhook-destinations");
    const result = await updateWebhookDestination("tenant_1", "dest_1", { endpointUrl: "https://new.example.test/wba" });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "dest_1" },
      data: { endpointUrl: "https://new.example.test/wba", deliverySuspensionUrl: "https://old.example.test/wba" },
    }));
    expect(result?.id).toBe("dest_1");
  });

  it("suspends deliveries atomically with the URL change inside one transaction", async () => {
    findFirst.mockResolvedValueOnce({ id: "dest_1", endpointUrl: "https://old.example.test/wba", retiredAt: null });
    update.mockResolvedValueOnce(destinationRow());
    const { updateWebhookDestination } = await import("@/lib/events/webhook-destinations");
    await updateWebhookDestination("tenant_1", "dest_1", { endpointUrl: "https://new.example.test/wba" });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(suspendDeliveriesForDestination).toHaveBeenCalledWith(
      expect.objectContaining({ webhookDestination: expect.anything() }),
      { tenantId: "tenant_1", destinationId: "dest_1" },
    );
  });

  it("does not suspend deliveries when URL is unchanged", async () => {
    findFirst.mockResolvedValueOnce({ id: "dest_1", endpointUrl: "https://hooks.example.test/wba", retiredAt: null });
    update.mockResolvedValueOnce(destinationRow());
    const { updateWebhookDestination } = await import("@/lib/events/webhook-destinations");
    await updateWebhookDestination("tenant_1", "dest_1", { name: "Renamed" });
    expect(suspendDeliveriesForDestination).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("does not select disabled or retired destinations for dispatch", async () => {
    findFirst.mockResolvedValueOnce(null);
    const { destinationForDispatch } = await import("@/lib/events/webhook-destinations");
    await expect(destinationForDispatch("tenant_1", "dest_1")).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant_1", id: "dest_1", enabled: true, retiredAt: null } }));
  });

  it("rejects a resume whose confirmation does not match the current endpoint URL", async () => {
    findFirst.mockResolvedValueOnce({ id: "dest_1", endpointUrl: "https://new.example.test/wba", enabled: true, retiredAt: null, deliverySuspensionUrl: "https://old.example.test/wba" });
    const { resolveSuspendedWebhookDeliveries } = await import("@/lib/events/webhook-destinations");
    const result = await resolveSuspendedWebhookDeliveries("tenant_1", "dest_1", { confirmEndpointUrl: "https://wrong.example.test/wba" });
    expect(result.status).toBe("url_mismatch");
    expect(resumeDeliveriesForDestination).not.toHaveBeenCalled();
  });

  it("requires explicit recipient acknowledgement when the endpoint URL changed", async () => {
    findFirst.mockResolvedValueOnce({ id: "dest_1", endpointUrl: "https://new.example.test/wba", enabled: true, retiredAt: null, deliverySuspensionUrl: "https://old.example.test/wba" });
    const { resolveSuspendedWebhookDeliveries } = await import("@/lib/events/webhook-destinations");
    const result = await resolveSuspendedWebhookDeliveries("tenant_1", "dest_1", { confirmEndpointUrl: "https://new.example.test/wba" });
    expect(result.status).toBe("confirmation_required");
    expect(result.requiresRecipientAcknowledgement).toBe(true);
    expect(resumeDeliveriesForDestination).not.toHaveBeenCalled();
  });

  it("resumes when the administrator confirms the current URL and acknowledges the recipient change", async () => {
    findFirst.mockResolvedValueOnce({ id: "dest_1", endpointUrl: "https://new.example.test/wba", enabled: true, retiredAt: null, deliverySuspensionUrl: "https://old.example.test/wba" });
    update.mockResolvedValueOnce(destinationRow({ deliverySuspensionUrl: null }));
    const { resolveSuspendedWebhookDeliveries } = await import("@/lib/events/webhook-destinations");
    const result = await resolveSuspendedWebhookDeliveries("tenant_1", "dest_1", {
      confirmEndpointUrl: "https://new.example.test/wba",
      acknowledgeRecipientChange: true,
    });
    expect(result.status).toBe("resumed");
    expect(result.resumed).toBe(3);
    expect(resumeDeliveriesForDestination).toHaveBeenCalledWith(
      expect.objectContaining({ webhookDestination: expect.anything() }),
      { tenantId: "tenant_1", destinationId: "dest_1" },
    );
  });

  it("treats an unrecognized tenant/destination as not found (cross-tenant rejection)", async () => {
    findFirst.mockResolvedValueOnce(null);
    const { resolveSuspendedWebhookDeliveries } = await import("@/lib/events/webhook-destinations");
    const result = await resolveSuspendedWebhookDeliveries("tenant_other", "dest_1", { confirmEndpointUrl: "https://new.example.test/wba" });
    expect(result.status).toBe("not_found");
  });
});
