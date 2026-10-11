/**
 * Redis connection management.
 *
 * Lazy singleton client: no network connection is established at module import.
 * The client is created and connected only when `getRedis()` is called.
 * Subsequent calls return the same instance.
 *
 * Key invariants:
 * - Connection failures are bounded (configured in config.ts).
 * - No credentials appear in logs.
 * - Repeated shutdown is safe.
 * - No connection is created per incoming HTTP request.
 *
 * For future standalone workers:
 *   Call `disconnectRedis()` during your graceful shutdown sequence,
 *   before exiting the process. Do not rely on garbage collection alone.
 */
import Redis from "ioredis";
import { loadRedisConfig, isRedisConfigured, type RedisConfig } from "./config";

type RedisClient = Redis;

/**
 * Module-level state. Stored on globalThis so Next.js route handlers
 * (running in a separate module graph from the custom server) share
 * the same instance as the server process.
 */
const g = globalThis as unknown as {
  __waRedis?: RedisClient;
  __waRedisConfig?: RedisConfig | null;
};

function createClient(cfg: RedisConfig): RedisClient {
  const redis = new Redis(cfg.url, {
    ...cfg.options,
    // Suppress the default ioredis password warning when a password is present.
    showFriendlyErrorStack: process.env.NODE_ENV === "development",
  });

  // Prevent unhandled rejections from silently crashing the process.
  redis.on("error", (err) => {
    // Log without exposing credentials.
    console.error(
      `[redis] connection error: ${err.message}`,
    );
  });

  redis.on("connect", () => {
    console.info("[redis] connected");
  });

  redis.on("reconnecting", () => {
    console.info("[redis] reconnecting");
  });

  return redis;
}

/**
 * Returns true when a Redis client is currently connected.
 * Returns false when Redis is not configured, not yet initialized,
 * or the connection has been closed.
 */
export function isRedisConnected(): boolean {
  const client = g.__waRedis;
  if (!client) return false;
  return client.status === "ready";
}

/**
 * Returns true when Redis is configured and a client instance exists,
 * regardless of its connection state.
 */
export function hasRedisClient(): boolean {
  return isRedisConfigured() && g.__waRedis !== undefined;
}

/**
 * Get or create the shared Redis client.
 *
 * Returns the client instance if REDIS_URL is configured (even if not yet
 * connected). Returns null when Redis is not configured, allowing callers
 * to gracefully degrade.
 *
 * The first call triggers connection setup. Subsequent calls return the
 * same instance. No connection is made at module import.
 */
export function getRedis(): RedisClient | null {
  if (!isRedisConfigured()) return null;

  if (!g.__waRedis) {
    const cfg = loadRedisConfig();
    if (!cfg) return null;
    g.__waRedisConfig = cfg;
    g.__waRedis = createClient(cfg);
  }

  return g.__waRedis;
}

/**
 * Connect the Redis client if configured and not yet connected.
 *
 * Idempotent: calling on an already-connected client is a no-op.
 * Throws if configuration is absent.
 *
 * @returns true if connected (or already connected), false if Redis not configured.
 */
export async function connectRedis(): Promise<boolean> {
  const client = getRedis();
  if (!client) return false;
  if (client.status === "ready" || client.status === "connecting") return true;
  await client.connect();
  return true;
}

/**
 * Gracefully disconnect the Redis client.
 *
 * Idempotent: safe to call multiple times.
 * Waits for any in-flight commands to finish before closing.
 * After disconnect the client instance remains on globalThis but
 * subsequent `getRedis()` will reconnect with a fresh client.
 */
export async function disconnectRedis(): Promise<void> {
  const client = g.__waRedis;
  if (!client) return;

  // Already closed — safe to call repeatedly.
  if (client.status === "close" || client.status === "end") return;

  // Disconnect and wait for graceful close.
  await client.quit().catch(() => {
    // Force close if quit times out.
    client.disconnect();
  });

  // Allow re-initialization on next getRedis() call.
  g.__waRedis = undefined;
  g.__waRedisConfig = undefined;
}

/**
 * Internal global key for Redis singleton. Exposed for testing only.
 * @internal
 */
export const __redisGlobalKey = "__waRedis" as const;
