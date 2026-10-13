import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => vi.fn());
const apiLogFindMany = vi.hoisted(() => vi.fn());
const apiLogCount = vi.hoisted(() => vi.fn());
const webhookFindMany = vi.hoisted(() => vi.fn());
const webhookCount = vi.hoisted(() => vi.fn());
const tenantMembershipFindUnique = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    apiLog: { findMany: apiLogFindMany, count: apiLogCount },
    webhookEvent: { findMany: webhookFindMany, count: webhookCount },
    tenantMembership: { findUnique: tenantMembershipFindUnique },
  },
}));

const makeRequest = (url: string) => new Request(`https://example.test${url}`);

async function getResponse(req: Request) {
  const { GET } = await import("@/app/api/logs/route");
  return GET(req, { params: Promise.resolve({}) });
}

describe("logs API — authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiLogFindMany.mockResolvedValue([]);
    apiLogCount.mockResolvedValue(0);
    webhookFindMany.mockResolvedValue([]);
    webhookCount.mockResolvedValue(0);
    tenantMembershipFindUnique.mockResolvedValue(null);
  });

  it("rejects unauthenticated requests with 401", async () => {
    auth.mockResolvedValue(null);
    const res = await getResponse(makeRequest("/api/logs"));
    expect(res.status).toBe(401);
  });

  it("rejects AGENT role with 403", async () => {
    auth.mockResolvedValue({ user: { id: "agent-1", role: "AGENT" } });
    const res = await getResponse(makeRequest("/api/logs"));
    expect(res.status).toBe(403);
    expect(apiLogFindMany).not.toHaveBeenCalled();
    expect(webhookFindMany).not.toHaveBeenCalled();
  });

  it("rejects tenant ADMIN without tenant filter", async () => {
    auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    const res = await getResponse(makeRequest("/api/logs"));
    expect(res.status).toBe(403);
    expect(apiLogFindMany).not.toHaveBeenCalled();
    expect(webhookFindMany).not.toHaveBeenCalled();
  });

  it("allows tenant ADMIN only for a member tenant", async () => {
    auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    tenantMembershipFindUnique.mockResolvedValue({ id: "m-1" });
    const res = await getResponse(makeRequest("/api/logs?tenantId=tenant-1"));
    expect(res.status).toBe(200);
    expect(apiLogFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: "tenant-1" }) }));
  });

  it("allows SYSTEM_ADMIN platform-level audit access", async () => {
    auth.mockResolvedValue({ user: { id: "system-1", role: "SYSTEM_ADMIN" } });
    const res = await getResponse(makeRequest("/api/logs?type=webhook"));
    expect(res.status).toBe(200);
    expect(webhookFindMany).toHaveBeenCalled();
  });

  it("allows SYSTEM_ADMIN API log access", async () => {
    auth.mockResolvedValue({ user: { id: "system-1", role: "SYSTEM_ADMIN" } });
    const res = await getResponse(makeRequest("/api/logs?type=api"));
    expect(res.status).toBe(200);
    expect(apiLogFindMany).toHaveBeenCalled();
  });
});

describe("logs API — pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiLogFindMany.mockResolvedValue([]);
    apiLogCount.mockResolvedValue(0);
    webhookFindMany.mockResolvedValue([]);
    webhookCount.mockResolvedValue(0);
    tenantMembershipFindUnique.mockResolvedValue(null);
  });

  it("defaults to page 1 with PAGE_SIZE", async () => {
    auth.mockResolvedValue({ user: { id: "sys", role: "SYSTEM_ADMIN" } });
    await getResponse(makeRequest("/api/logs"));
    expect(apiLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 50 }),
    );
  });

  it("respects pageSize up to MAX_PAGE_SIZE (200)", async () => {
    auth.mockResolvedValue({ user: { id: "sys", role: "SYSTEM_ADMIN" } });
    await getResponse(makeRequest("/api/logs?page=1&pageSize=200"));
    expect(apiLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 }),
    );
  });

  it("caps pageSize above MAX_PAGE_SIZE", async () => {
    auth.mockResolvedValue({ user: { id: "sys", role: "SYSTEM_ADMIN" } });
    await getResponse(makeRequest("/api/logs?pageSize=500"));
    expect(apiLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 }),
    );
  });

  it("orders by createdAt desc", async () => {
    auth.mockResolvedValue({ user: { id: "sys", role: "SYSTEM_ADMIN" } });
    await getResponse(makeRequest("/api/logs"));
    expect(apiLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "desc" } }),
    );
  });
});

describe("logs API — API log filters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiLogFindMany.mockResolvedValue([]);
    apiLogCount.mockResolvedValue(0);
  });

  it("applies method filter (uppercase)", async () => {
    auth.mockResolvedValue({ user: { id: "sys", role: "SYSTEM_ADMIN" } });
    await getResponse(makeRequest("/api/logs?method=post"));
    expect(apiLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ method: "POST" }) }),
    );
  });

  it("applies endpoint partial match filter", async () => {
    auth.mockResolvedValue({ user: { id: "sys", role: "SYSTEM_ADMIN" } });
    await getResponse(makeRequest("/api/logs?endpoint=v18"));
    expect(apiLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ endpoint: { contains: "v18", mode: "insensitive" } }) }),
    );
  });

  it("applies ok=true filter", async () => {
    auth.mockResolvedValue({ user: { id: "sys", role: "SYSTEM_ADMIN" } });
    await getResponse(makeRequest("/api/logs?ok=true"));
    expect(apiLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ ok: true }) }),
    );
  });

  it("applies ok=false filter", async () => {
    auth.mockResolvedValue({ user: { id: "sys", role: "SYSTEM_ADMIN" } });
    await getResponse(makeRequest("/api/logs?ok=false"));
    expect(apiLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ ok: false }) }),
    );
  });

  it("applies related filter", async () => {
    auth.mockResolvedValue({ user: { id: "sys", role: "SYSTEM_ADMIN" } });
    await getResponse(makeRequest("/api/logs?related=template"));
    expect(apiLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ relatedType: "template" }) }),
    );
  });

  it("applies date range from/to filters", async () => {
    auth.mockResolvedValue({ user: { id: "sys", role: "SYSTEM_ADMIN" } });
    await getResponse(makeRequest("/api/logs?from=2025-01-01T00:00:00Z&to=2025-12-31T23:59:59Z"));
    expect(apiLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({
            gte: new Date("2025-01-01T00:00:00Z"),
            lte: new Date("2025-12-31T23:59:59Z"),
          }),
        }),
      }),
    );
  });
});

describe("logs API — webhook filters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    webhookFindMany.mockResolvedValue([]);
    webhookCount.mockResolvedValue(0);
    tenantMembershipFindUnique.mockResolvedValue(null);
  });

  it("applies sig=valid filter", async () => {
    auth.mockResolvedValue({ user: { id: "sys", role: "SYSTEM_ADMIN" } });
    await getResponse(makeRequest("/api/logs?type=webhook&sig=valid"));
    expect(webhookFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ signatureValid: true }) }),
    );
  });

  it("applies sig=invalid filter", async () => {
    auth.mockResolvedValue({ user: { id: "sys", role: "SYSTEM_ADMIN" } });
    await getResponse(makeRequest("/api/logs?type=webhook&sig=invalid"));
    expect(webhookFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ signatureValid: false }) }),
    );
  });

  it("applies processed=ok filter", async () => {
    auth.mockResolvedValue({ user: { id: "sys", role: "SYSTEM_ADMIN" } });
    await getResponse(makeRequest("/api/logs?type=webhook&processed=ok"));
    expect(webhookFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ processedOk: true }) }),
    );
  });

  it("applies processed=error filter", async () => {
    auth.mockResolvedValue({ user: { id: "sys", role: "SYSTEM_ADMIN" } });
    await getResponse(makeRequest("/api/logs?type=webhook&processed=error"));
    expect(webhookFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ processedOk: false }) }),
    );
  });

  it("distinguishes HTTP receipt from processing success", async () => {
    auth.mockResolvedValue({ user: { id: "sys", role: "SYSTEM_ADMIN" } });
    // A webhook with valid signature but processedOk=false means HTTP received but processing failed.
    webhookFindMany.mockResolvedValue([{ id: "ev-1", signatureValid: true, processedOk: false, eventSummary: "processing error", error: "tenant mismatch", createdAt: new Date().toISOString() }]);
    webhookCount.mockResolvedValue(1);

    const res = await getResponse(makeRequest("/api/logs?type=webhook"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0].processedOk).toBe(false);
    expect(body.items[0].error).toBe("tenant mismatch");
    // HTTP 200 was returned to Meta immediately; processedOk=false means async worker failed.
  });
});

describe("logs API — response shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiLogFindMany.mockResolvedValue([
      { id: "log-1", method: "POST", endpoint: "/v18.0/123456/messages", ok: true, responseStatus: 200, durationMs: 340, relatedType: "message", relatedId: "msg-1", createdAt: new Date("2025-06-01T10:00:00Z") },
    ]);
    apiLogCount.mockResolvedValue(1);
  });

  it("returns type, items, total, page, pageSize", async () => {
    auth.mockResolvedValue({ user: { id: "sys", role: "SYSTEM_ADMIN" } });
    const res = await getResponse(makeRequest("/api/logs"));
    const body = await res.json();
    expect(body).toMatchObject({
      type: "api",
      total: 1,
      page: 1,
      pageSize: 50,
    });
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items[0].method).toBe("POST");
  });
});
