/**
 * ERA 2 — Durable Broadcast Queue Configuration & Feature Flag.
 *
 * Defaults to false: preserving legacy in-process broadcast execution until
 * explicitly activated.
 */

export const WHATSAPP_BROADCAST_ASYNC_ENABLED = "WHATSAPP_BROADCAST_ASYNC_ENABLED";

export function isBroadcastAsyncEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[WHATSAPP_BROADCAST_ASYNC_ENABLED]?.toLowerCase() === "true";
}

export const BROADCAST_DISPATCH_LIMITER = {
  max: 20,
  duration: 1000,
} as const;

export const DEFAULT_BROADCAST_WORKER_CONCURRENCY = 5;
