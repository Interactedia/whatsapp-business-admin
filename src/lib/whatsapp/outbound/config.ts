/**
 * Feature flag controlling whether the durable outbound message processing
 * path is active. Default false — the legacy synchronous `sendMessage` path
 * remains active for all callers until this is explicitly enabled.
 *
 * Set WHATSAPP_OUTBOUND_ASYNC_ENABLED=true to route the v1/messages endpoint
 * through the durable outbox + BullMQ worker. Even when enabled, callers
 * receive an explicit "accepted" response, not a Meta-confirmed response.
 */

export const WHATSAPP_OUTBOUND_ASYNC_ENABLED = "WHATSAPP_OUTBOUND_ASYNC_ENABLED";

export function isOutboundAsyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[WHATSAPP_OUTBOUND_ASYNC_ENABLED]?.toLowerCase() === "true";
}
