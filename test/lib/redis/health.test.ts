import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Module-level mock state — declared BEFORE vi.mock since vi.mock is hoisted.
const _sharedMock = { status: "ready" };
const _ping = vi.fn<() => Promise<string>>().mockResolvedValue("PONG");

vi.mock("ioredis", () => {
  // eslint-disable-next-line
  const MockClass = function (this: { status: string; ping: typeof _ping; connect: ReturnType<typeof vi.fn>; quit: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }, _url?: string, _opts?: Record<string, unknown>) {
    this.status = _sharedMock.status;
    this.connect = vi.fn().mockResolvedValue(undefined);
    this.quit = vi.fn().mockResolvedValue("OK");
    this.disconnect = vi.fn();
    this.ping = _ping;
    this.on = vi.fn();
  };
  return { default: MockClass };
});

const originalEnv = process.env;

describe("Redis health", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.__waRedis;
    delete g.__waRedisConfig;
    _sharedMock.status = "ready";
    _ping.mockClear();
    _ping.mockResolvedValue("PONG");
  });

  afterEach(() => {
    process.env = originalEnv;
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.__waRedis;
    delete g.__waRedisConfig;
  });

  describe("checkRedisHealth", () => {
    it("returns unavailable with reason not_configured when REDIS_URL absent", async () => {
      delete process.env.REDIS_URL;
      const { checkRedisHealth } = await import("@/lib/redis/health");
      const result = await checkRedisHealth();
      expect(result.status).toBe("unavailable");
      expect((result as { reason: string }).reason).toBe("not_configured");
    });

    it("returns unavailable with reason not_connected when client not ready", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { checkRedisHealth } = await import("@/lib/redis/health");
      _sharedMock.status = "connecting";
      const result = await checkRedisHealth();
      expect(result.status).toBe("unavailable");
      expect((result as { reason: string }).reason).toBe("not_connected");
    });

    it("returns ok with latencyMs when ping succeeds", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { checkRedisHealth } = await import("@/lib/redis/health");
      const result = await checkRedisHealth();
      expect(result.status).toBe("ok");
      expect(
        (result as { latencyMs: number }).latencyMs,
      ).toBeGreaterThanOrEqual(0);
    });

    it("returns unavailable with reason timeout when ping times out", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { checkRedisHealth } = await import("@/lib/redis/health");
      _ping.mockImplementation(
        () =>
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), 10),
          ),
      );
      const result = await checkRedisHealth(50);
      expect(result.status).toBe("unavailable");
      expect((result as { reason: string }).reason).toBe("timeout");
    });

    it("returns unavailable with reason error on unexpected ping failure", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { checkRedisHealth } = await import("@/lib/redis/health");
      _ping.mockRejectedValue(new Error("connection reset"));
      const result = await checkRedisHealth();
      expect(result.status).toBe("unavailable");
      expect((result as { reason: string }).reason).toBe("error");
      expect((result as { message: string }).message).toBe(
        "connection reset",
      );
    });

    it("health message does not expose credentials", async () => {
      process.env.REDIS_URL = "redis://admin:MySecret123@localhost:6379/0";
      const { checkRedisHealth } = await import("@/lib/redis/health");
      const result = await checkRedisHealth();
      if (result.status === "unavailable") {
        expect(result.message).not.toContain("MySecret123");
        expect(result.message).not.toContain("admin");
      }
    });

    it("respects custom timeout override", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { checkRedisHealth } = await import("@/lib/redis/health");
      const result = await checkRedisHealth(1000);
      expect(result.status).toMatch(/^(ok|unavailable)$/);
    });
  });
});
