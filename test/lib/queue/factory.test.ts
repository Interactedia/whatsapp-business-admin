import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createQueue,
  getRegisteredQueue,
  closeQueue,
  closeAllQueues,
  getQueueRegistrySize,
} from "@/lib/queue/factory";

const _closeMock = vi.fn().mockResolvedValue(undefined);

vi.mock("bullmq", () => {
  const MockQueue = function (this: { name: string; opts: Record<string, unknown>; close: typeof _closeMock }, name: string, opts?: Record<string, unknown>) {
    this.name = name;
    this.opts = opts ?? {};
    this.close = _closeMock;
  };
  return { Queue: MockQueue };
});

vi.mock("@/lib/queue/connection", () => ({
  getBullMQConnectionOptions: vi.fn().mockReturnValue({ host: "127.0.0.1", port: 6379 }),
}));

describe("Queue factory", () => {
  beforeEach(async () => {
    _closeMock.mockClear();
    await closeAllQueues();
  });

  afterEach(async () => {
    await closeAllQueues();
  });

  it("createQueue registers and configures queue", () => {
    const queue = createQueue("test-queue");
    expect(queue.name).toBe("test-queue");
    expect(getQueueRegistrySize()).toBe(1);
    expect(getRegisteredQueue("test-queue")).toBe(queue);
  });

  it("closeQueue closes queue and removes it from registry", async () => {
    const queue = createQueue("test-queue-2");
    expect(getQueueRegistrySize()).toBe(1);

    await closeQueue(queue);
    expect(_closeMock).toHaveBeenCalled();
    expect(getQueueRegistrySize()).toBe(0);
    expect(getRegisteredQueue("test-queue-2")).toBeUndefined();
  });

  it("closeAllQueues closes all registered queues and empties registry", async () => {
    createQueue("q1");
    createQueue("q2");
    expect(getQueueRegistrySize()).toBe(2);

    await closeAllQueues();
    expect(getQueueRegistrySize()).toBe(0);
    expect(_closeMock).toHaveBeenCalledTimes(2);
  });

  it("repeated closeAllQueues is safe", async () => {
    createQueue("q1");
    await closeAllQueues();
    expect(getQueueRegistrySize()).toBe(0);

    await expect(closeAllQueues()).resolves.toBeUndefined();
  });
});
