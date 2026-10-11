import { describe, expect, it, vi } from "vitest";
import { inspectQueue } from "@/lib/queue/inspection";
import type { Queue } from "bullmq";

describe("Queue inspection", () => {
  it("inspects job counts and paused status accurately", async () => {
    const mockCounts = {
      waiting: 5,
      active: 2,
      completed: 100,
      failed: 3,
      delayed: 1,
      prioritized: 0,
      "waiting-children": 0,
    };

    const mockQueue = {
      name: "inspect-queue",
      getJobCounts: vi.fn().mockResolvedValue(mockCounts),
      isPaused: vi.fn().mockResolvedValue(false),
    } as unknown as Queue;

    const result = await inspectQueue(mockQueue);

    expect(result.name).toBe("inspect-queue");
    expect(result.isPaused).toBe(false);
    expect(result.counts.waiting).toBe(5);
    expect(result.counts.active).toBe(2);
    expect(result.counts.completed).toBe(100);
    expect(result.counts.failed).toBe(3);
    expect(result.counts.delayed).toBe(1);
    expect(result.counts.prioritized).toBe(0);
    expect(result.counts.waitingChildren).toBe(0);
    expect(result.total).toBe(111);
    expect(result.timestamp).toBeDefined();
  });

  it("handles empty / zero counts gracefully", async () => {
    const mockQueue = {
      name: "empty-queue",
      getJobCounts: vi.fn().mockResolvedValue({}),
      isPaused: vi.fn().mockResolvedValue(true),
    } as unknown as Queue;

    const result = await inspectQueue(mockQueue);

    expect(result.name).toBe("empty-queue");
    expect(result.isPaused).toBe(true);
    expect(result.counts.waiting).toBe(0);
    expect(result.counts.active).toBe(0);
    expect(result.total).toBe(0);
  });
});
