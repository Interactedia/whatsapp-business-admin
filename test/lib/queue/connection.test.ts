import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  isQueueConfigured,
  getBullMQConnectionOptions,
  createBullMQConnection,
  closeConnection,
  closeAllConnections,
  getTrackedConnectionsCount,
} from "@/lib/queue/connection";
import { QueueConfigurationError } from "@/lib/queue/config";

const _quitMock = vi.fn().mockResolvedValue("OK");
const _disconnectMock = vi.fn();

vi.mock("ioredis", () => {
  // eslint-disable-next-line
  const MockClass = function (this: { status: string; quit: typeof _quitMock; disconnect: typeof _disconnectMock; on: ReturnType<typeof vi.fn> }, _url?: string, _opts?: Record<string, unknown>) {
    this.status = "ready";
    this.quit = _quitMock;
    this.disconnect = _disconnectMock;
    this.on = vi.fn();
  };
  return { default: MockClass };
});

describe("BullMQ connection management", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    _quitMock.mockClear();
    _disconnectMock.mockClear();
  });

  afterEach(async () => {
    process.env = originalEnv;
    await closeAllConnections();
  });

  it("isQueueConfigured reflects REDIS_URL state", () => {
    delete process.env.REDIS_URL;
    expect(isQueueConfigured()).toBe(false);

    process.env.REDIS_URL = "redis://localhost:6379";
    expect(isQueueConfigured()).toBe(true);
  });

  it("getBullMQConnectionOptions throws when REDIS_URL absent", () => {
    delete process.env.REDIS_URL;
    expect(() => getBullMQConnectionOptions()).toThrow(QueueConfigurationError);
  });

  it("getBullMQConnectionOptions returns valid options with null maxRetriesPerRequest", () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const options = getBullMQConnectionOptions() as Record<string, unknown>;

    expect(options.url).toBe("redis://127.0.0.1:6379");
    expect(options.maxRetriesPerRequest).toBeNull();
    expect(options.enableReadyCheck).toBe(false);
  });

  it("createBullMQConnection tracks connection and allows safe close", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";

    const initialCount = getTrackedConnectionsCount();
    const client = createBullMQConnection();

    expect(getTrackedConnectionsCount()).toBe(initialCount + 1);

    await closeConnection(client);
    expect(getTrackedConnectionsCount()).toBe(initialCount);
    expect(_quitMock).toHaveBeenCalled();
  });

  it("closeAllConnections closes all tracked connections and clears registry", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";

    createBullMQConnection();
    createBullMQConnection();

    expect(getTrackedConnectionsCount()).toBe(2);

    await closeAllConnections();
    expect(getTrackedConnectionsCount()).toBe(0);
    expect(_quitMock).toHaveBeenCalledTimes(2);
  });

  it("repeated closeAllConnections is safe", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";

    createBullMQConnection();
    await closeAllConnections();
    expect(getTrackedConnectionsCount()).toBe(0);

    // Second call should not throw
    await expect(closeAllConnections()).resolves.toBeUndefined();
  });
});
