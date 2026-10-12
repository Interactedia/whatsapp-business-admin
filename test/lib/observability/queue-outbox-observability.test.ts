import { describe, expect, it, vi } from "vitest";

describe("outbox observability", () => {
  it("aggregates outbox and outbound attempt states without payload reads", async () => {
    const db = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ state: "PENDING", count: 3n }, { state: "PUBLISHED", count: 7n }])
        .mockResolvedValueOnce([{ createdAt: new Date("2026-10-11T00:00:00.000Z") }])
        .mockResolvedValueOnce([{ count: 1n }])
        .mockResolvedValueOnce([{ state: "UNCERTAIN", count: 2n }, { state: "FAILED", count: 4n }]),
    };
    const { collectOutboxObservability } = await import("@/lib/outbox/observability");

    const result = await collectOutboxObservability(db as never);

    expect(result).toMatchObject({
      available: true,
      outbox: { pending: 3, published: 7, expiredLeases: 1 },
      outboundAttempts: [{ state: "UNCERTAIN", count: 2 }, { state: "FAILED", count: 4 }],
    });
    expect(db.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it("returns unavailable instead of false zeros on database failure", async () => {
    const db = { $queryRaw: vi.fn().mockRejectedValue(new Error("db down")) };
    const { collectOutboxObservability } = await import("@/lib/outbox/observability");

    const result = await collectOutboxObservability(db as never);

    expect(result).toMatchObject({ available: false, error: "Error" });
  });
});

describe("queue observability", () => {
  it("returns unavailable without creating queues when Redis is not configured", async () => {
    vi.resetModules();
    vi.doMock("@/lib/queue", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/queue")>();
      return { ...actual, isQueueConfigured: () => false };
    });
    const { collectQueueObservability } = await import("@/lib/queue/observability");

    const result = await collectQueueObservability();

    expect(result.available).toBe(false);
    expect(result.queues).toHaveLength(4);
    expect(result.queues.every((queue) => !queue.available && queue.error === "Redis is not configured")).toBe(true);
  });
});
