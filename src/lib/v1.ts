import { NextResponse } from "next/server";
import { verifyApiKey, type ApiKeyPrincipal } from "@/lib/api-keys";
import { TenantAuthorizationError } from "@/lib/tenant";

/** Error carrying an HTTP status for v1 handlers. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function apiOk<T extends object>(data: T, init?: number) {
  return NextResponse.json({ status: "success", ...data }, { status: init ?? 200 });
}

export function apiFail(status: number, message: string) {
  return NextResponse.json({ status: "error", message }, { status });
}

/** Parse a JSON request body without disguising malformed JSON as missing fields. */
export async function parseJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ApiError(400, "Invalid JSON request body. Check for missing commas, quotes, or brackets.");
  }
}

/** Extract a presented key from header, bearer token, query, or JSON body. */
export function extractApiKey(req: Request, body?: Record<string, unknown>): string | null {
  const header = req.headers.get("x-api-key");
  if (header) return header.trim();

  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();

  const url = new URL(req.url);
  const q = url.searchParams.get("apikey");
  if (q) return q.trim();

  if (body && typeof body.apikey === "string") return body.apikey.trim();
  return null;
}

/** Authenticate a v1 request; throws ApiError(401) when the key is missing/invalid. */
export async function requireApiKey(req: Request, body?: Record<string, unknown>): Promise<ApiKeyPrincipal> {
  const key = extractApiKey(req, body);
  const principal = await verifyApiKey(key);
  if (!principal) throw new ApiError(401, "Invalid or missing API key");
  return principal;
}

/** Wrap a v1 route so thrown ApiError / other errors become {status:"error"} JSON. */
export function v1Handle(
  fn: (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>,
) {
  return async (req: Request, ctx: { params: Promise<Record<string, string>> }) => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof ApiError) return apiFail(err.status, err.message);
      if (err instanceof TenantAuthorizationError) return apiFail(403, err.message);
      // Zod validation error → clean 400 with readable messages.
      if (err && typeof err === "object" && "issues" in err && Array.isArray((err as { issues: unknown[] }).issues)) {
        const issues = (err as { issues: { path: (string | number)[]; message: string }[] }).issues;
        const msg = issues
          .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
          .join("; ");
        return apiFail(400, msg || "Invalid request");
      }
      // WhatsApp/domain errors expose a status too.
      if (err && typeof err === "object" && "status" in err && "message" in err) {
        const e = err as { status: number; message: string };
        if (typeof e.status === "number") return apiFail(e.status, e.message);
      }
      console.error("v1 API error:", err);
      return apiFail(500, err instanceof Error ? err.message : "Internal error");
    }
  };
}
