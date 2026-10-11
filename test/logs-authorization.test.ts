import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => vi.fn());
const apiLogFindMany = vi.hoisted(() => vi.fn());
const apiLogCount = vi.hoisted(() => vi.fn());
const webhookFindMany = vi.hoisted(() => vi.fn());
const webhookCount = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    apiLog: { findMany: apiLogFindMany, count: apiLogCount },
    webhookEvent: { findMany: webhookFindMany, count: webhookCount },
  },
}));

describe("legacy audit log authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiLogFindMany.mockResolvedValue([]);
    apiLogCount.mockResolvedValue(0);
    webhookFindMany.mockResolvedValue([]);
    webhookCount.mockResolvedValue(0);
  });

  it("denies tenant ADMIN because legacy logs have no tenant ownership", async () => {
    auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    const { GET } = await import("@/app/api/logs/route");

    const response = await GET(new Request("https://example.test/api/logs"), { params: Promise.resolve({}) });

    expect(response.status).toBe(403);
    expect(apiLogFindMany).not.toHaveBeenCalled();
    expect(webhookFindMany).not.toHaveBeenCalled();
  });

  it("allows SYSTEM_ADMIN platform-level audit access", async () => {
    auth.mockResolvedValue({ user: { id: "system-1", role: "SYSTEM_ADMIN" } });
    const { GET } = await import("@/app/api/logs/route");

    const response = await GET(new Request("https://example.test/api/logs?type=webhook"), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(200);
    expect(webhookFindMany).toHaveBeenCalled();
  });
});
