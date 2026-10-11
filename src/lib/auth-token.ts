/**
 * Decode a NextAuth (Auth.js v5) session cookie outside of the Next request
 * context — used by the WebSocket upgrade handler in the custom server.
 *
 * Auth.js encrypts the JWT (JWE) with AUTH_SECRET, salted by the cookie name.
 * We try both the dev and the __Secure- production cookie names.
 */
import { decode } from "next-auth/jwt";

const COOKIE_NAMES = ["authjs.session-token", "__Secure-authjs.session-token"];

function getSecret(): string {
  return process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || "";
}

export type SessionInfo = { userId: string; role: string };

export type AuthDiagnostic = {
  reason:
    | "missing_secret"
    | "empty_header"
    | "token_not_found"
    | "decode_failed"
    | "missing_sub";
  cookieNamesPresent: string[];
};

export function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;

  const pairs: string[] = [];
  let current = "";
  let inQuotes = false;
  let escaped = false;

  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (ch === ";" && !inQuotes) {
      pairs.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) {
    pairs.push(current);
  }

  for (const part of pairs) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    let v = part.slice(idx + 1).trim();
    if (!k) continue;

    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      v = v.slice(1, -1);
      v = v.replace(/\\(.)/g, "$1");
    }

    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export async function verifySessionToken(
  cookieHeader: string,
  onDiagnostic?: (diagnostic: AuthDiagnostic) => void,
): Promise<SessionInfo | null> {
  const emitDiagnostic = (diag: AuthDiagnostic) => {
    if (onDiagnostic) {
      onDiagnostic(diag);
    }
    if (process.env.NODE_ENV !== "test") {
      console.warn(
        `[realtime:auth] Verification failed: reason=${diag.reason} cookiesPresent=[${diag.cookieNamesPresent.join(", ")}]`,
      );
    }
  };

  const secret = getSecret();
  if (!secret) {
    emitDiagnostic({ reason: "missing_secret", cookieNamesPresent: [] });
    return null;
  }
  if (!cookieHeader) {
    emitDiagnostic({ reason: "empty_header", cookieNamesPresent: [] });
    return null;
  }

  const cookies = parseCookies(cookieHeader);
  const cookieNamesPresent = Object.keys(cookies);

  let triedAny = false;
  for (const name of COOKIE_NAMES) {
    const token = cookies[name];
    if (!token) continue;
    triedAny = true;
    try {
      const decoded = await decode({ token, secret, salt: name });
      if (decoded?.sub) {
        return { userId: decoded.sub, role: (decoded as { role?: string }).role || "AGENT" };
      }
      emitDiagnostic({ reason: "missing_sub", cookieNamesPresent });
    } catch {
      emitDiagnostic({ reason: "decode_failed", cookieNamesPresent });
    }
  }

  if (!triedAny) {
    emitDiagnostic({ reason: "token_not_found", cookieNamesPresent });
  }

  return null;
}
