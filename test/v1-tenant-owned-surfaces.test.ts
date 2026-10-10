import { beforeEach, describe, expect, it, vi } from "vitest";

const apiKeyFindUnique = vi.hoisted(() => vi.fn());
const apiKeyUpdate = vi.hoisted(() => vi.fn());
const templateFindMany = vi.hoisted(() => vi.fn());
const templateFindFirst = vi.hoisted(() => vi.fn());
const flowFindMany = vi.hoisted(() => vi.fn());
const contactFindMany = vi.hoisted(() => vi.fn());
const broadcastCreate = vi.hoisted(() => vi.fn());
const runBroadcast = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: {
    apiKey: { findUnique: apiKeyFindUnique, update: apiKeyUpdate },
    template: { findMany: templateFindMany, findFirst: templateFindFirst },
    flow: { findMany: flowFindMany },
    contact: { findMany: contactFindMany },
    broadcast: { create: broadcastCreate },
  },
}));

vi.mock("@/lib/whatsapp/broadcast", () => ({ runBroadcast }));

function apiRequest(path: string, init?: RequestInit) {
  return new Request(`https://example.test${path}`, {
    ...init,
    headers: { "x-api-key": "k", "content-type": "application/json", ...(init?.headers || {}) },
  });
}

const routeContext = { params: Promise.resolve({}) };

describe("WA-ERA1-BATCH-C-R3 v1 tenant-owned surfaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiKeyFindUnique.mockResolvedValue({ id: "key-1", createdById: "user-1", tenantId: "tenant-1", revoked: false });
    apiKeyUpdate.mockResolvedValue({});
  });

  it("lists only tenant-owned templates and rejects legacy keys", async () => {
    templateFindMany.mockResolvedValue([]);
    const { GET } = await import("@/app/api/v1/templates/route");

    await GET(apiRequest("/api/v1/templates?status=approved"), routeContext);

    expect(templateFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1", status: "APPROVED" },
    }));

    apiKeyFindUnique.mockResolvedValueOnce({ id: "legacy-key", createdById: "user-1", tenantId: null, revoked: false });
    const denied = await GET(apiRequest("/api/v1/templates"), routeContext);
    expect(denied.status).toBe(403);
  });

  it("lists only tenant-owned published flows", async () => {
    flowFindMany.mockResolvedValue([]);
    const { GET } = await import("@/app/api/v1/flows/route");

    await GET(apiRequest("/api/v1/flows"), routeContext);

    expect(flowFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1", versions: { some: { status: "PUBLISHED" } } },
    }));
  });

  it("creates broadcasts only from tenant-owned templates and contacts", async () => {
    templateFindFirst.mockResolvedValue({ id: "template-1" });
    contactFindMany.mockResolvedValue([{ id: "contact-1" }]);
    broadcastCreate.mockResolvedValue({ id: "broadcast-1" });
    runBroadcast.mockResolvedValue(undefined);
    const { POST } = await import("@/app/api/v1/broadcasts/route");

    const response = await POST(apiRequest("/api/v1/broadcasts", {
      method: "POST",
      body: JSON.stringify({ name: "B", template: "welcome", audience: { type: "tag", tag: "vip" } }),
    }), routeContext);

    expect(response.status).toBe(201);
    expect(templateFindFirst).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", name: "welcome", status: "APPROVED" },
    });
    expect(contactFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1", tags: { has: "vip" } },
    }));
    expect(broadcastCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tenantId: "tenant-1", templateId: "template-1" }),
    }));
  });

  it("denies null-owned or foreign templates for broadcasts without side effects", async () => {
    templateFindFirst.mockResolvedValue(null);
    const { POST } = await import("@/app/api/v1/broadcasts/route");

    const response = await POST(apiRequest("/api/v1/broadcasts", {
      method: "POST",
      body: JSON.stringify({ name: "B", template: "legacy" }),
    }), routeContext);

    expect(response.status).toBe(404);
    expect(contactFindMany).not.toHaveBeenCalled();
    expect(broadcastCreate).not.toHaveBeenCalled();
    expect(runBroadcast).not.toHaveBeenCalled();
  });
});
