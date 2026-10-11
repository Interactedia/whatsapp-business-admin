export const WHATSAPP_INBOUND_ASYNC_ENABLED = "WHATSAPP_INBOUND_ASYNC_ENABLED";

export function isInboundAsyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[WHATSAPP_INBOUND_ASYNC_ENABLED]?.toLowerCase() === "true";
}
