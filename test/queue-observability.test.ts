import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => vi.fn());
const collectQueueObservability = vi.hoisted(() => vi.fn());
const collectOutboxObservability = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/queue/observability", () => ({ collectQueueObservability }));
vi.mock("@/lib/outbox/observability", () => ({ collectOutboxObservability }));

describe("queue observability API authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collectQueueObservability.mockResolvedValue({ available: true, queues: [], collectedAt: "2026-10-11T00:00:00.000Z" });
    collectOutboxObservability.mockResolvedValue({
      available: true,
      outbox: { pending: 0, claimed: 0, published: 0, retryable: 0, terminal: 0, expiredLeases: 0, oldestPendingAgeMs: null },
      outboundAttempts: [{ state: "UNCERTAIN", count: 2 }],
      collectedAt: "2026-10-11T00:00:00.000Z",
    });
  });

  it("rejects tenant ADMIN from global metrics", async () => {
    auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    const { GET } = await import("@/app/api/admin/queue-observability/route");

    const response = await GET(new Request("https://example.test/api/admin/queue-observability"), { params: Promise.resolve({}) });

    expect(response.status).toBe(403);
    expect(collectQueueObservability).not.toHaveBeenCalled();
    expect(collectOutboxObservability).not.toHaveBeenCalled();
  });

  it("allows SYSTEM_ADMIN and returns interpretation notes", async () => {
    auth.mockResolvedValue({ user: { id: "system-1", role: "SYSTEM_ADMIN" } });
    const { GET } = await import("@/app/api/admin/queue-observability/route");

    const response = await GET(new Request("https://example.test/api/admin/queue-observability"), { params: Promise.resolve({}) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.database.outboundAttempts).toEqual([{ state: "UNCERTAIN", count: 2 }]);
    expect(body.notes.queueCompletion).toContain("not Meta delivery evidence");
    expect(body.notes.uncertain).toContain("not safe to retry automatically");
  });

  it("keeps PostgreSQL metrics when Redis is unavailable", async () => {
    auth.mockResolvedValue({ user: { id: "system-1", role: "SYSTEM_ADMIN" } });
    collectQueueObservability.mockResolvedValue({
      available: false,
      queues: [{ name: "wa-message-outbound", available: false, error: "Error" }],
      collectedAt: "2026-10-11T00:00:00.000Z",
    });
    const { GET } = await import("@/app/api/admin/queue-observability/route");

    const response = await GET(new Request("https://example.test/api/admin/queue-observability"), { params: Promise.resolve({}) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.queues.available).toBe(false);
    expect(body.database.available).toBe(true);
    expect(body.queues.queues[0].error).toBe("Error");
  });

  it("keeps queue metrics when PostgreSQL is unavailable", async () => {
    auth.mockResolvedValue({ user: { id: "system-1", role: "SYSTEM_ADMIN" } });
    collectOutboxObservability.mockResolvedValue({ available: false, error: "PrismaClientKnownRequestError", collectedAt: "2026-10-11T00:00:00.000Z" });
    const { GET } = await import("@/app/api/admin/queue-observability/route");

    const response = await GET(new Request("https://example.test/api/admin/queue-observability"), { params: Promise.resolve({}) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.queues.available).toBe(true);
    expect(body.database).toEqual({ available: false, error: "PrismaClientKnownRequestError", collectedAt: "2026-10-11T00:00:00.000Z" });
  });
});
