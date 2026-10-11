import { headers } from "next/headers";

/**
 * Build a public-facing base URL for the current request, preferring
 * X-Forwarded-* headers (set by ngrok, cloudflared, reverse proxies) so the
 * webhook callback URL, API docs, and tenant-scoped links all reflect the
 * host the user is actually reaching, not the local listen address.
 *
 * Returns the public origin (no trailing slash) or falls back to APP_URL
 * / localhost when called outside a request context.
 */
export async function publicBaseUrl(): Promise<string> {
  const h = await headers();
  const xfHost = h.get("x-forwarded-host") || h.get("host");
  if (xfHost) {
    const xfProto = h.get("x-forwarded-proto");
    const proto =
      xfProto ||
      (xfHost.startsWith("localhost") ||
      xfHost.startsWith("127.") ||
      xfHost.startsWith("0.0.0.0")
        ? "http"
        : "https");
    return `${proto}://${xfHost}`;
  }
  return process.env.APP_URL || "http://localhost:3000";
}

/**
 * Synchronous variant for use inside a route handler (where `Request` is in
 * scope). Honours X-Forwarded-Proto / X-Forwarded-Host, then falls back to
 * APP_URL.
 */
export function publicBaseUrlFromRequest(req: Request): string {
  const xfHost = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (xfHost) {
    const xfProto = req.headers.get("x-forwarded-proto");
    const proto =
      xfProto ||
      (xfHost.startsWith("localhost") ||
      xfHost.startsWith("127.") ||
      xfHost.startsWith("0.0.0.0")
        ? "http"
        : "https");
    return `${proto}://${xfHost}`;
  }
  return process.env.APP_URL || "http://localhost:3000";
}
