import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createWorker,
  closeWorker,
  closeAllWorkers,
  getWorkerRegistrySize,
} from "@/lib/queue/worker";

const _closeMock = vi.fn().mockResolvedValue(undefined);
const _listeners = new Map<string, ((...args: unknown[]) => void)[]>();

vi.mock("bullmq", () => {
  const MockWorker = function (
    this: {
      name: string;
      processor: unknown;
      opts: Record<string, unknown>;
      close: typeof _closeMock;
      on: ReturnType<typeof vi.fn>;
    },
    name: string,
    processor: unknown,
    opts?: Record<string, unknown>
  ) {
    this.name = name;
    this.processor = processor;
    this.opts = opts ?? {};
    this.close = _closeMock;
    this.on = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      const list = _listeners.get(event) ?? [];
      list.push(cb);
      _listeners.set(event, list);
      return this;
    });
  };
  return { Worker: MockWorker };
});

vi.mock("@/lib/queue/connection", () => ({
  getBullMQConnectionOptions: vi.fn().mockReturnValue({ host: "127.0.0.1", port: 6379 }),
}));

describe("Worker factory", () => {
  beforeEach(async () => {
    _closeMock.mockClear();
    _listeners.clear();
    await closeAllWorkers();
  });

  afterEach(async () => {
    await closeAllWorkers();
  });

  it("createWorker registers and initializes worker", () => {
    const processor = vi.fn();
    const worker = createWorker("test-work-queue", processor, { concurrency: 3 });

    expect(worker.name).toBe("test-work-queue");
    expect(getWorkerRegistrySize()).toBe(1);
    expect(worker.opts.concurrency).toBe(3);
  });

  it("attaches error and failed event handlers", () => {
    const onError = vi.fn();
    const onFailed = vi.fn();

    createWorker("test-handlers", vi.fn(), { onError, onFailed });

    const errorHandlers = _listeners.get("error");
    const failedHandlers = _listeners.get("failed");

    expect(errorHandlers?.length).toBeGreaterThan(0);
    expect(failedHandlers?.length).toBeGreaterThan(0);

    // Simulate error event
    const testError = new Error("simulated failure");
    errorHandlers?.[0](testError);
    expect(onError).toHaveBeenCalledWith(testError);

    // Simulate failed event
    const mockJob = { id: "job-123" };
    failedHandlers?.[0](mockJob, testError);
    expect(onFailed).toHaveBeenCalledWith(mockJob, testError);
  });

  it("closeWorker closes worker and removes from registry", async () => {
    const worker = createWorker("w-close", vi.fn());
    expect(getWorkerRegistrySize()).toBe(1);

    await closeWorker(worker);
    expect(_closeMock).toHaveBeenCalled();
    expect(getWorkerRegistrySize()).toBe(0);
  });

  it("closeAllWorkers closes all registered workers and clears registry", async () => {
    createWorker("w1", vi.fn());
    createWorker("w2", vi.fn());
    expect(getWorkerRegistrySize()).toBe(2);

    await closeAllWorkers();
    expect(getWorkerRegistrySize()).toBe(0);
    expect(_closeMock).toHaveBeenCalledTimes(2);
  });

  it("repeated closeAllWorkers is safe", async () => {
    createWorker("w1", vi.fn());
    await closeAllWorkers();
    expect(getWorkerRegistrySize()).toBe(0);

    await expect(closeAllWorkers()).resolves.toBeUndefined();
  });
});
