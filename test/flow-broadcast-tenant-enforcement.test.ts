import { beforeEach, describe, expect, it, vi } from "vitest";

const flowFindFirst = vi.hoisted(() => vi.fn());
const broadcastFindUnique = vi.hoisted(() => vi.fn());
const ensureConversation = vi.hoisted(() => vi.fn());
const isWithinSessionWindow = vi.hoisted(() => vi.fn());
const broadcastUpdate = vi.hoisted(() => vi.fn());
const flowLaunchCreate = vi.hoisted(() => vi.fn());
const flowLaunchUpdate = vi.hoisted(() => vi.fn());
const sendMessage = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: {
    flow: { findFirst: flowFindFirst },
    flowLaunch: { create: flowLaunchCreate, update: flowLaunchUpdate },
    broadcast: { findUnique: broadcastFindUnique, update: broadcastUpdate },
  },
}));

vi.mock("@/lib/crypto", () => ({ encrypt: (value: string) => value }));
vi.mock("@/lib/settings", () => ({ getWabaConfig: vi.fn(async () => ({ phoneNumberId: "123" })) }));
vi.mock("@/lib/whatsapp/client", () => ({ graphFetch: vi.fn(), WhatsAppApiError: class WhatsAppApiError extends Error { status?: number; constructor(status: number, message: string) { super(message); this.status = status; } } }));
vi.mock("@/lib/whatsapp/send", () => ({
  ensureConversation,
  isWithinSessionWindow,
  sendMessage,
}));
vi.mock("@/lib/whatsapp/flow-crypto", () => ({
  flowTokenHash: (value: string) => `hash:${value}`,
  newFlowToken: () => "token",
}));

const publishedVersion = {
  id: "version-1",
  metaFlowId: "meta-flow-1",
  flowJson: { screens: [{ id: "START" }] },
};

describe("WA-ERA1-BATCH-C-R3 flow and broadcast tenant enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isWithinSessionWindow.mockReturnValue(true);
    ensureConversation.mockResolvedValue({
      contact: { id: "contact-1", tenantId: "tenant-1" },
      conversation: { id: "conversation-1", tenantId: "tenant-1", lastInboundAt: new Date() },
    });
    flowLaunchCreate.mockResolvedValue({ id: "launch-1" });
    flowLaunchUpdate.mockResolvedValue({});
    sendMessage.mockResolvedValue({ id: "message-1", waMessageId: "wamid.1" });
  });

  it("loads launchable flows through tenant ownership", async () => {
    flowFindFirst.mockResolvedValue({ id: "flow-1", tenantId: "tenant-1", versions: [publishedVersion] });
    const { launchFlow } = await import("@/lib/whatsapp/flow-launch");

    await launchFlow({ flowId: "flow-1", tenantId: "tenant-1", to: "919812345678" });

    expect(flowFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "flow-1", tenantId: "tenant-1" },
    }));
  });

  it("denies foreign or null-owned launch conversations", async () => {
    flowFindFirst.mockResolvedValue({ id: "flow-1", tenantId: "tenant-1", versions: [publishedVersion] });
    ensureConversation.mockResolvedValueOnce({
      contact: { id: "contact-2", tenantId: "tenant-2" },
      conversation: { id: "conversation-2", tenantId: "tenant-2", lastInboundAt: new Date() },
    });
    const { launchFlow } = await import("@/lib/whatsapp/flow-launch");

    await expect(launchFlow({ flowId: "flow-1", tenantId: "tenant-1", to: "919812345678" })).rejects.toMatchObject({ status: 404 });
  });

  it("denies null-owned broadcasts before side effects", async () => {
    broadcastFindUnique.mockResolvedValue({ id: "broadcast-1", tenantId: null, template: { tenantId: null }, recipients: [] });
    const { runBroadcast } = await import("@/lib/whatsapp/broadcast");

    await expect(runBroadcast("broadcast-1")).rejects.toMatchObject({ status: 403 });
    expect(broadcastUpdate).not.toHaveBeenCalled();
  });

  it("denies broadcasts whose template is foreign-owned", async () => {
    broadcastFindUnique.mockResolvedValue({ id: "broadcast-1", tenantId: "tenant-1", template: { tenantId: "tenant-2" }, recipients: [] });
    const { runBroadcast } = await import("@/lib/whatsapp/broadcast");

    await expect(runBroadcast("broadcast-1")).rejects.toMatchObject({ status: 403 });
    expect(broadcastUpdate).not.toHaveBeenCalled();
  });
});
