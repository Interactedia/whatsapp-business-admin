import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  loadRedisConfig,
  isRedisConfigured,
  RedisConfigurationError,
} from "@/lib/redis/config";

describe("Redis configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("loadRedisConfig", () => {
    it("returns null when REDIS_URL is absent", () => {
      delete process.env.REDIS_URL;
      expect(loadRedisConfig()).toBeNull();
    });

    it("returns null when REDIS_URL is empty string", () => {
      process.env.REDIS_URL = "";
      expect(loadRedisConfig()).toBeNull();
    });

    it("returns config for valid REDIS_URL", () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const result = loadRedisConfig();
      expect(result).not.toBeNull();
      expect(result!.url).toBe("redis://localhost:6379");
      expect(result!.options.connectTimeout).toBe(5000);
      expect(result!.options.maxRetriesPerRequest).toBe(3);
      expect(result!.options.lazyConnect).toBe(true);
    });

    it("uses REDIS_CONNECT_TIMEOUT_MS when set", () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      process.env.REDIS_CONNECT_TIMEOUT_MS = "10000";
      expect(loadRedisConfig()!.options.connectTimeout).toBe(10000);
    });

    it("clamps REDIS_CONNECT_TIMEOUT_MS to minimum of 1", () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      process.env.REDIS_CONNECT_TIMEOUT_MS = "0";
      expect(loadRedisConfig()!.options.connectTimeout).toBe(1);
    });

    it("uses REDIS_MAX_RETRIES when set", () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      process.env.REDIS_MAX_RETRIES = "5";
      expect(loadRedisConfig()!.options.maxRetriesPerRequest).toBe(5);
    });

    it("clamps REDIS_MAX_RETRIES to minimum of 0", () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      process.env.REDIS_MAX_RETRIES = "-1";
      expect(loadRedisConfig()!.options.maxRetriesPerRequest).toBe(0);
    });

    it("throws RedisConfigurationError for invalid REDIS_URL", () => {
      process.env.REDIS_URL = "not a valid url";
      expect(() => loadRedisConfig()).toThrow(RedisConfigurationError);
      expect(() => loadRedisConfig()).toThrow(/invalid URL format/i);
    });

    it("RedisConfigurationError message does not leak credentials", () => {
      // Use a malformed URL containing credentials to test redaction.
      process.env.REDIS_URL = "://admin:SuperSecret123@localhost:6379";
      try {
        loadRedisConfig();
        expect.fail("expected RedisConfigurationError");
      } catch (err) {
        expect(err).toBeInstanceOf(RedisConfigurationError);
        const msg = (err as RedisConfigurationError).message;
        expect(msg).not.toContain("SuperSecret123");
        expect(msg).not.toContain("admin");
        expect(msg).toMatch(/invalid URL format/i);
      }
    });

    it("retryStrategy returns null after maxRetries exceeded", () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      process.env.REDIS_MAX_RETRIES = "2";
      const { options } = loadRedisConfig()!;
      const retryStrategy = options.retryStrategy!;

      expect(retryStrategy(1)).toBe(500);
      expect(retryStrategy(2)).toBe(1000);
      expect(retryStrategy(3)).toBeNull(); // stops after maxRetries
    });

    it("retryStrategy caps delay at 10000ms before maxRetries", () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      // Set maxRetries high enough so that the cap (10000ms) is reachable:
      // times*500 >= 10000 requires times >= 20.
      // BullMQ calls retryStrategy up to maxRetries+1 times, so maxRetries >= 20.
      process.env.REDIS_MAX_RETRIES = "20";
      const { options } = loadRedisConfig()!;
      const retryStrategy = options.retryStrategy!;

      // retryStrategy(20): 20*500=10000, capped at 10000. times<=maxRetries so no null.
      expect(retryStrategy(20)).toBe(10000);
    });
  });

  describe("isRedisConfigured", () => {
    it("returns false when REDIS_URL is absent", () => {
      delete process.env.REDIS_URL;
      expect(isRedisConfigured()).toBe(false);
    });

    it("returns false when REDIS_URL is empty", () => {
      process.env.REDIS_URL = "";
      expect(isRedisConfigured()).toBe(false);
    });

    it("returns true when REDIS_URL is set", () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      expect(isRedisConfigured()).toBe(true);
    });
  });
});
