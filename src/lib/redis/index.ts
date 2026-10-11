/**
 * Redis infrastructure public API.
 *
 * Usage:
 *   import { getRedis, disconnectRedis, checkRedisHealth } from "@/lib/redis";
 *
 * Redis is optional. The application starts without Redis when REDIS_URL is absent.
 *
 * For future standalone workers:
 *   import { disconnectRedis } from "@/lib/redis";
 *   process.on("SIGTERM", async () => { await disconnectRedis(); process.exit(0); });
 *   process.on("SIGINT",  async () => { await disconnectRedis(); process.exit(0); });
 */

// Configuration
export { loadRedisConfig, isRedisConfigured } from "./config";
export type { RedisConfig, RedisConfigurationError } from "./config";

// Connection management
export { getRedis, connectRedis, disconnectRedis } from "./client";
export { isRedisConnected, hasRedisClient } from "./client";

// Health inspection
export { checkRedisHealth } from "./health";
export type { RedisHealthResult } from "./health";
