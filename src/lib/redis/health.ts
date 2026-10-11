/**
 * Redis health inspection.
 *
 * Provides a programmatic health check for Redis connectivity.
 * Does not expose a public HTTP endpoint — callers integrate as needed.
 */
import { getRedis } from "./client";
import { isRedisConfigured } from "./config";

export type RedisHealthResult =
  | {
      status: "ok";
      latencyMs: number;
    }
  | {
      status: "unavailable";
      reason: "not_configured" | "not_connected" | "timeout" | "error";
      message: string;
    };

/**
 * Check Redis connectivity using PING.
 *
 * - Returns "ok" when Redis is configured, connected, and responds.
 * - Returns "unavailable" for all other cases including not configured,
 *   not connected, timeout, or unexpected error.
 * - Respects the configured connect timeout (default 5s).
 * - No credentials appear in the returned message.
 *
 * @param timeoutMs Override the health-check timeout. Defaults to the
 *                  configured connectTimeout from config.ts.
 */
export async function checkRedisHealth(
  timeoutMs?: number,
): Promise<RedisHealthResult> {
  if (!isRedisConfigured()) {
    return {
      status: "unavailable",
      reason: "not_configured",
      message: "Redis is not configured (REDIS_URL is not set)",
    };
  }

  const client = getRedis();
  if (!client) {
    return {
      status: "unavailable",
      reason: "not_connected",
      message: "Redis client not initialized",
    };
  }

  if (client.status !== "ready") {
    return {
      status: "unavailable",
      reason: "not_connected",
      message: `Redis client status: ${client.status}`,
    };
  }

  const timeout = timeoutMs ?? 5_000;

  let latencyMs = 0;
  try {
    const t0 = Date.now();
    const result = await Promise.race([
      client.ping(),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeout),
      ),
    ]);
    latencyMs = Date.now() - t0;

    if (result !== "PONG") {
      return {
        status: "unavailable",
        reason: "error",
        message: "Unexpected PING response",
      };
    }

    return { status: "ok", latencyMs };
  } catch (err) {
    const reason =
      err instanceof Error && err.message === "timeout"
        ? "timeout"
        : "error";
    const message =
      err instanceof Error ? err.message : "Unknown health check error";

    return { status: "unavailable", reason, message };
  }
}
