/**
 * BullMQ Redis connection management.
 *
 * Invariants:
 * - Separated from the Next.js application Redis singleton (__waRedis).
 * - BullMQ requires `maxRetriesPerRequest: null` for blocking operations.
 * - Credential redaction: credentials never appear in logs or errors.
 * - Safe repeated cleanup.
 */

import type { ConnectionOptions } from "bullmq";
import Redis, { type RedisOptions } from "ioredis";
import { loadRedisConfig, isRedisConfigured } from "../redis/config";
import { QueueConfigurationError } from "./config";

const trackedConnections = new Set<Redis>();

/**
 * Checks whether Redis is configured for queue operations.
 */
export function isQueueConfigured(): boolean {
  return isRedisConfigured();
}

/**
 * Returns connection options configured specifically for BullMQ.
 * BullMQ will manage its own internal ioredis instance and lifecycle.
 */
export function getBullMQConnectionOptions(): ConnectionOptions {
  const redisConfig = loadRedisConfig();
  if (!redisConfig) {
    throw new QueueConfigurationError(
      "Redis is not configured. REDIS_URL must be set for queue operations."
    );
  }

  return {
    ...redisConfig.options,
    url: redisConfig.url,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  } as ConnectionOptions;
}

/**
 * Creates an explicitly managed ioredis instance for BullMQ with required settings.
 * The instance is tracked in the connection registry for coordinated shutdown.
 */
export function createBullMQConnection(options?: Partial<RedisOptions>): Redis {
  const redisConfig = loadRedisConfig();
  if (!redisConfig) {
    throw new QueueConfigurationError(
      "Redis is not configured. REDIS_URL must be set for queue operations."
    );
  }

  const client = new Redis(redisConfig.url, {
    ...redisConfig.options,
    ...options,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  });

  client.on("error", (err) => {
    console.error(`[bullmq-redis] connection error: ${err.message}`);
  });

  trackedConnections.add(client);
  return client;
}

/**
 * Closes an explicitly managed BullMQ Redis connection.
 */
export async function closeConnection(client: Redis): Promise<void> {
  try {
    if (client.status !== "end") {
      await client.quit().catch(() => {
        client.disconnect();
      });
    }
  } finally {
    trackedConnections.delete(client);
  }
}

/**
 * Closes all explicitly tracked BullMQ Redis connections.
 * Safe to call repeatedly.
 */
export async function closeAllConnections(): Promise<void> {
  const clients = Array.from(trackedConnections);
  trackedConnections.clear();
  await Promise.all(
    clients.map(async (client) => {
      try {
        if (client.status !== "end") {
          await client.quit().catch(() => {
            client.disconnect();
          });
        }
      } catch {
        // Safe repeated shutdown
      }
    })
  );
}

/**
 * Returns the count of actively tracked dedicated connections.
 */
export function getTrackedConnectionsCount(): number {
  return trackedConnections.size;
}
