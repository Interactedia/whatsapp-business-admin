import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createQueueEvents,
  closeQueueEvents,
  closeAllQueueEvents,
  getEventsRegistrySize,
} from "@/lib/queue/events";

const _closeMock = vi.fn().mockResolvedValue(undefined);

vi.mock("bullmq", () => {
  const MockQueueEvents = function (
    this: { name: string; opts: Record<string, unknown>; close: typeof _closeMock; on: ReturnType<typeof vi.fn> },
    name: string,
    opts?: Record<string, unknown>
  ) {
    this.name = name;
    this.opts = opts ?? {};
    this.close = _closeMock;
    this.on = vi.fn().mockReturnThis();
  };
  return { QueueEvents: MockQueueEvents };
});

vi.mock("@/lib/queue/connection", () => ({
  getBullMQConnectionOptions: vi.fn().mockReturnValue({ host: "127.0.0.1", port: 6379 }),
}));

describe("QueueEvents factory", () => {
  beforeEach(async () => {
    _closeMock.mockClear();
    await closeAllQueueEvents();
  });

  afterEach(async () => {
    await closeAllQueueEvents();
  });

  it("createQueueEvents registers QueueEvents instance", () => {
    const events = createQueueEvents("test-events-queue");
    expect(events.name).toBe("test-events-queue");
    expect(getEventsRegistrySize()).toBe(1);
  });

  it("closeQueueEvents closes instance and removes from registry", async () => {
    const events = createQueueEvents("ev-close");
    expect(getEventsRegistrySize()).toBe(1);

    await closeQueueEvents(events);
    expect(_closeMock).toHaveBeenCalled();
    expect(getEventsRegistrySize()).toBe(0);
  });

  it("closeAllQueueEvents closes all and clears registry", async () => {
    createQueueEvents("ev1");
    createQueueEvents("ev2");
    expect(getEventsRegistrySize()).toBe(2);

    await closeAllQueueEvents();
    expect(getEventsRegistrySize()).toBe(0);
    expect(_closeMock).toHaveBeenCalledTimes(2);
  });

  it("repeated closeAllQueueEvents is safe", async () => {
    createQueueEvents("ev1");
    await closeAllQueueEvents();
    expect(getEventsRegistrySize()).toBe(0);

    await expect(closeAllQueueEvents()).resolves.toBeUndefined();
  });
});
