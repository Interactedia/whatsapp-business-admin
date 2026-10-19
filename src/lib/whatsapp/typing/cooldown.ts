/**
 * WA-TYPING-01 (simplified) — Atomic per-recipient typing cooldown in Redis.
 *
 * One typing request per (tenant, sender phone number, recipient waId) per
 * TYPING_COOLDOWN_MS window. The window matches Meta's documented typing
 * indicator lifetime (~25s): a successful indicator stays visible until the
 * operator's message arrives or the window expires, so additional pings
 * inside the window are pure noise and are discarded BEFORE being enqueued.
 *
 * Why Redis and not an in-process Map:
 *   - The Next.js route handlers and the custom server may run in separate
 *     module graphs / processes; a local counter is not a shared authority.
 *   - `SET key value NX PX ms` is atomic, so concurrent HTTP requests cannot
 *     both acquire the slot.
 *   - Keys expire on their own: no cleanup job, and a server restart cannot
 *     resurrect a stale window (the window lives in Redis, not in memory).
 *
 * Why this also kills "late typing after Send":
 *   - The cooldown is acquired at request time and the per-phone p-queue has
 *     NO interval scheduling, so a request is either dispatched immediately
 *     (behind at most the in-flight request) or discarded. Nothing is ever
 *     scheduled for the future, therefore nothing can fire after the
 *     operator pressed Send.
 *   - The browser additionally aborts its in-flight typing fetch on Send
 *     (best effort). The residual race — the request already passed the
 *     cooldown and reached Meta around the same instant as the Send — is a
 *     sub-second window; Meta hides the indicator once the message arrives.
 *     This implementation does NOT claim a stronger ordering guarantee.
 *
 * Failure mode: when Redis is not configured or a command errors, typing
 * pings are discarded (fail-closed). Typing is ephemeral UX; losing it
 * during a Redis outage is acceptable, duplicate Meta traffic is not.
 */
import { getRedis } from "@/lib/redis/client";
import { TYPING_COOLDOWN_MS } from "./config";

/**
 * Try to acquire the typing slot for this tenant/sender/recipient triple.
 * Returns true when the caller may dispatch a typing request now.
 */
export async function tryAcquireTypingCooldown(
  tenantId: string,
  metaPhoneNumberId: string,
  recipientWaId: string,
): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false; // Redis absent → typing disabled (fail-closed)

  const key = `typing:cooldown:${tenantId}:${metaPhoneNumberId}:${recipientWaId}`;
  try {
    const acquired = await redis.set(key, Date.now().toString(), "PX", TYPING_COOLDOWN_MS, "NX");
    return acquired === "OK";
  } catch {
    // Connection-level errors are already logged by the redis client.
    return false;
  }
}
