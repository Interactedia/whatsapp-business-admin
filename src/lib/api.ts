import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { WhatsAppApiError } from "@/lib/whatsapp/client";
import type { Session } from "next-auth";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Standard JSON success body. */
export function ok<T>(data: T, init?: number | ResponseInit) {
  const responseInit = typeof init === "number" ? { status: init } : init;
  return NextResponse.json(data, responseInit);
}

export function fail(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

/** Get the session or throw 401. */
export async function requireUser(): Promise<Session> {
  const session = await auth();
  if (!session?.user) throw new HttpError(401, "Unauthorized");
  return session;
}

/** Get the session or throw 403 unless the user is an admin. */
export async function requireAdmin(): Promise<Session> {
  const session = await requireUser();
  if (session.user.role !== "ADMIN" && session.user.role !== "SYSTEM_ADMIN") {
    throw new HttpError(403, "Admins only");
  }
  return session;
}

/**
 * Wrap an async route handler so thrown HttpError / ZodError / generic errors
 * become clean JSON responses.
 */
export function handle(
  fn: (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>,
) {
  return async (req: Request, ctx: { params: Promise<Record<string, string>> }) => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status, err.message);
      if (err instanceof WhatsAppApiError) {
        // ponytail: surface Meta's user-facing explanation (error_user_msg)
        // when available; it is more actionable than the generic message.
        const friendly = err.userMessage || err.message;
        return fail(err.status, friendly);
      }
      if (err && typeof err === "object" && "issues" in err) {
        // ZodError
        return fail(400, JSON.stringify((err as { issues: unknown }).issues));
      }
      console.error("API error:", err);
      const message = err instanceof Error ? err.message : "Internal error";
      return fail(500, message);
    }
  };
}
