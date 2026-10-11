export const WHATSAPP_STATUS_ASYNC_ENABLED = "WHATSAPP_STATUS_ASYNC_ENABLED";

export function isStatusAsyncEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[WHATSAPP_STATUS_ASYNC_ENABLED]?.toLowerCase() === "true";
}
