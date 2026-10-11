import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { __redisGlobalKey } from "@/lib/redis/client";

// Module-level mock state — declared BEFORE vi.mock since vi.mock is hoisted.
const _sharedMock = { status: "ready" };
const _connect = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const _quit = vi.fn<() => Promise<string>>().mockResolvedValue("OK");
const _disconnect = vi.fn<() => void>();
const _ping = vi.fn<() => Promise<string>>().mockResolvedValue("PONG");

vi.mock("ioredis", () => {
  // eslint-disable-next-line
  const MockClass = function (this: { status: string; connect: typeof _connect; quit: typeof _quit; disconnect: typeof _disconnect; ping: typeof _ping; on: ReturnType<typeof vi.fn> }, _url?: string, _opts?: Record<string, unknown>) {
    this.status = _sharedMock.status;
    this.connect = _connect;
    this.quit = _quit;
    this.disconnect = _disconnect;
    this.ping = _ping;
    this.on = vi.fn();
  };
  return { default: MockClass };
});

const originalEnv = process.env;

describe("Redis client", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    const g = globalThis as unknown as Record<string, unknown>;
    delete g[__redisGlobalKey];
    delete g.__waRedisConfig;
    _sharedMock.status = "ready";
    _connect.mockClear();
    _quit.mockClear();
    _disconnect.mockClear();
    _ping.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
    const g = globalThis as unknown as Record<string, unknown>;
    delete g[__redisGlobalKey];
    delete g.__waRedisConfig;
  });

  describe("getRedis", () => {
    it("returns null when REDIS_URL is not set", async () => {
      delete process.env.REDIS_URL;
      const { getRedis } = await import("@/lib/redis/client");
      expect(getRedis()).toBeNull();
    });

    it("returns null when REDIS_URL is empty", async () => {
      process.env.REDIS_URL = "";
      const { getRedis } = await import("@/lib/redis/client");
      expect(getRedis()).toBeNull();
    });

    it("creates and stores a client on globalThis when REDIS_URL is set", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { getRedis } = await import("@/lib/redis/client");
      const client = getRedis();
      expect(client).not.toBeNull();
      const g = globalThis as unknown as Record<string, unknown>;
      expect(g[__redisGlobalKey]).toBe(client);
    });

    it("returns the same instance on subsequent calls (singleton)", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { getRedis } = await import("@/lib/redis/client");
      const first = getRedis();
      const second = getRedis();
      expect(first).toBe(second);
    });

    it("registers event handlers on the client (lazy init)", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { getRedis } = await import("@/lib/redis/client");
      const g = globalThis as unknown as Record<string, unknown>;
      expect(g[__redisGlobalKey]).toBeUndefined();
      getRedis();
      expect(g[__redisGlobalKey]).toBeDefined();
    });

    it("does not call connect() automatically (lazyConnect)", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { getRedis } = await import("@/lib/redis/client");
      getRedis();
      expect(_connect).not.toHaveBeenCalled();
    });
  });

  describe("connectRedis", () => {
    it("returns false when Redis is not configured", async () => {
      delete process.env.REDIS_URL;
      const { connectRedis } = await import("@/lib/redis/client");
      const result = await connectRedis();
      expect(result).toBe(false);
    });

    it("returns true and creates singleton when configured", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { connectRedis } = await import("@/lib/redis/client");
      const result = await connectRedis();
      expect(result).toBe(true);
      const g = globalThis as unknown as Record<string, unknown>;
      expect(g[__redisGlobalKey]).toBeDefined();
    });

    it("is idempotent when already connecting", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { connectRedis, getRedis } = await import("@/lib/redis/client");
      getRedis();
      _sharedMock.status = "connecting";
      const result = await connectRedis();
      expect(result).toBe(true);
    });
  });

  describe("disconnectRedis", () => {
    it("is safe to call when client does not exist", async () => {
      delete process.env.REDIS_URL;
      const { disconnectRedis } = await import("@/lib/redis/client");
      await expect(disconnectRedis()).resolves.toBeUndefined();
    });

    it("is safe to call when client is already closed", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { disconnectRedis, getRedis } = await import("@/lib/redis/client");
      const client = getRedis()!;
      client.status = "end";
      await expect(disconnectRedis()).resolves.toBeUndefined();
    });

    it("clears the singleton after disconnect", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { getRedis, disconnectRedis } = await import("@/lib/redis/client");
      const g = globalThis as unknown as Record<string, unknown>;
      const first = getRedis();
      expect(g[__redisGlobalKey]).toBe(first);
      await disconnectRedis();
      expect(g[__redisGlobalKey]).toBeUndefined();
    });

    it("allows re-initialization after disconnect", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { getRedis, disconnectRedis } = await import("@/lib/redis/client");
      const first = getRedis();
      await disconnectRedis();
      const second = getRedis();
      expect(second).not.toBe(first);
    });
  });

  describe("isRedisConnected", () => {
    it("returns false when client not initialized", async () => {
      delete process.env.REDIS_URL;
      const { isRedisConnected } = await import("@/lib/redis/client");
      expect(isRedisConnected()).toBe(false);
    });

    it("returns true when client status is ready", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { getRedis, isRedisConnected } = await import("@/lib/redis/client");
      getRedis();
      expect(isRedisConnected()).toBe(true);
    });

    it("returns false when client status is not ready", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { getRedis, isRedisConnected } = await import("@/lib/redis/client");
      _sharedMock.status = "connecting";
      getRedis();
      expect(isRedisConnected()).toBe(false);
    });
  });

  describe("hasRedisClient", () => {
    it("returns false when REDIS_URL is not set", async () => {
      delete process.env.REDIS_URL;
      const { hasRedisClient } = await import("@/lib/redis/client");
      expect(hasRedisClient()).toBe(false);
    });

    it("returns false when client not yet created", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { hasRedisClient } = await import("@/lib/redis/client");
      expect(hasRedisClient()).toBe(false);
    });

    it("returns true after client is created", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { getRedis, hasRedisClient } = await import("@/lib/redis/client");
      getRedis();
      expect(hasRedisClient()).toBe(true);
    });
  });
});
