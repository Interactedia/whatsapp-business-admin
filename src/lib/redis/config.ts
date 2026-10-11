/**
 * Redis configuration.
 *
 * Loads and validates server-side Redis configuration from environment variables.
 * REDIS_URL is optional — when absent the application starts without Redis.
 * No credentials may appear in logs.
 */

import type { RedisOptions } from "ioredis";

export type RedisConfig = {
  /** Full Redis connection URL. Required for Redis to be available. */
  url: string;
  /** Bounded connection options derived from optional env vars. */
  options: Omit<RedisOptions, "connectTimeout" | "maxRetriesPerRequest"> & {
    /** Connection timeout in milliseconds. Default: 5000. */
    connectTimeout: number;
    /** Maximum retry attempts on transient failure. Default: 3. */
    maxRetriesPerRequest: number;
  };
};

/** Error thrown when Redis configuration is present but invalid. */
export class RedisConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedisConfigurationError";
  }
}

function buildErrorMessage(field: string, reason: string): string {
  return `Redis configuration error: ${field} — ${reason}`;
}

/**
 * Load and validate Redis configuration from environment variables.
 *
 * - REDIS_URL must be set to enable Redis connectivity.
 * - Optional bounded overrides: REDIS_CONNECT_TIMEOUT_MS, REDIS_MAX_RETRIES.
 * - Returns null when REDIS_URL is absent (Redis remains optional).
 * - Throws RedisConfigurationError on malformed URL.
 * - Credentials are redacted from all error messages.
 */
export function loadRedisConfig(): RedisConfig | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  try {
    // Validate URL format by parsing. Throws if malformed.
    new URL(url);
  } catch {
    throw new RedisConfigurationError(
      buildErrorMessage("REDIS_URL", "invalid URL format"),
    );
  }

  const connectTimeout = Math.max(
    1,
    Number(process.env.REDIS_CONNECT_TIMEOUT_MS ?? "5000"),
  );
  const maxRetries = Math.max(
    0,
    Number(process.env.REDIS_MAX_RETRIES ?? "3"),
  );

  const options: RedisConfig["options"] = {
    connectTimeout,
    maxRetriesPerRequest: maxRetries,
    lazyConnect: true,
    retryStrategy: (times) => {
      if (times > maxRetries) return null;
      return Math.min(times * 500, 10_000);
    },
  };

  return { url, options };
}

/**
 * Check whether Redis is configured (REDIS_URL is set).
 * Does not validate URL format.
 */
export function isRedisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL);
}
