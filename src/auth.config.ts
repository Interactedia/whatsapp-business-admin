import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe auth config (no DB, no Node-only deps) shared by the middleware and
 * the full server config in `auth.ts`. Providers are added in `auth.ts`.
 */
const protectedTenantReadPattern =
  /^\/api\/tenants\/[^/]+\/(?:contacts|conversations|memberships)\/[^/]+$/;
const protectedTenantListPattern =
  /^\/api\/tenants\/?$|^\/api\/tenants\/[^/]+\/(?:contacts|conversations|memberships)\/?$/;
const protectedTenantMessageHistoryPattern =
  /^\/api\/tenants\/[^/]+\/conversations\/[^/]+\/messages\/?$/;
/** Tenant-scoped write endpoints (POST/PATCH/DELETE) that need auth protection. */
const protectedTenantWritePatterns = [
  /^\/api\/tenants\/?$/,                                          // POST tenant
  /^\/api\/tenants\/[^/]+\/memberships\/?$/,                      // POST membership
  /^\/api\/tenants\/[^/]+\/contacts\/?$/,                         // POST contact
  /^\/api\/tenants\/[^/]+\/contacts\/[^/]+\/?$/,                // PATCH/DELETE contact
  /^\/api\/tenants\/[^/]+\/conversations\/?$/,                  // POST conversation
  /^\/api\/tenants\/[^/]+\/conversations\/[^/]+\/?$/,           // PATCH/DELETE conversation
  /^\/api\/tenants\/[^/]+\/conversations\/[^/]+\/messages\/?$/, // POST message
];

/**
 * Build a public-facing absolute URL for the current request, preferring
 * X-Forwarded-* headers (set by ngrok, cloudflared, reverse proxies) over the
 * raw `Host` header. This keeps login redirects and CSRF cookies valid when
 * the app is reached through a tunnel.
 */
function publicUrlFromHeaders(headers: Headers, path: string = "/"): URL {
  const xfHost = headers.get("x-forwarded-host");
  const xfProto = headers.get("x-forwarded-proto");
  const host = xfHost || headers.get("host") || "localhost:3000";
  const proto = xfProto || (host.startsWith("localhost") || host.startsWith("127.") || host.startsWith("0.0.0.0") ? "http" : "https");
  // Normalize: drop any default ports to match what the browser sees.
  const cleanHost = host.replace(/:\d+$/, "");
  const port = host.match(/:(\d+)$/)?.[1];
  const defaultPort = proto === "https" ? "443" : "80";
  const portPart = port && port !== defaultPort ? `:${port}` : "";
  return new URL(`${path}${portPart ? "" : ""}`, `${proto}://${cleanHost}${portPart}`);
}

export const authConfig: NextAuthConfig = {
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [],
  callbacks: {
    authorized({ auth, request }) {
      const isLoggedIn = !!auth?.user;
      const { nextUrl } = request;
      const isOnLogin = nextUrl.pathname.startsWith("/login");
      if (isOnLogin) {
        if (isLoggedIn) {
          return Response.redirect(publicUrlFromHeaders(request.headers, "/"));
        }
        return true;
      }
      if (!isLoggedIn) {
        // Write methods (POST/PATCH/DELETE) on protected patterns: 401.
        if (["POST", "PATCH", "DELETE"].includes(request.method)) {
          if (
            protectedTenantWritePatterns.some((p) => p.test(nextUrl.pathname)) ||
            protectedTenantListPattern.test(nextUrl.pathname) ||
            protectedTenantReadPattern.test(nextUrl.pathname) ||
            protectedTenantMessageHistoryPattern.test(nextUrl.pathname)
          ) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
          }
        }
        // Read methods (GET) on protected patterns: 401.
        if (
          request.method === "GET" &&
          (protectedTenantReadPattern.test(nextUrl.pathname) ||
            protectedTenantListPattern.test(nextUrl.pathname) ||
            protectedTenantMessageHistoryPattern.test(nextUrl.pathname))
        ) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
      }
      // For page navigations and non-protected API paths, return false and
      // let NextAuth handle the redirect. With `trustHost: true` plus
      // `AUTH_URL` set in the env, NextAuth will use the public host for the
      // callbackUrl.
      return isLoggedIn;
    },
    /**
     * Re-base any Auth.js-emitted redirect (signIn, signOut, callbackUrl) on
     * the public host. Without this the URL leaks the local listen address
     * (0.0.0.0:4020) which the browser cannot reach through a tunnel.
     */
    redirect({ url, baseUrl }) {
      // If the URL is already absolute and points at a known public host,
      // pass it through. Otherwise re-base it on the request's public URL.
      try {
        const target = new URL(url, baseUrl);
        // Allow same-origin and relative redirects.
        if (target.origin === baseUrl || url.startsWith("/")) {
          return target.toString();
        }
        // External URL: leave alone.
        return url;
      } catch {
        return baseUrl;
      }
    },
    jwt({ token, user }) {
      if (user) {
        token.role = user.role;
        token.name = user.name;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub as string;
        session.user.role = (token.role as "SYSTEM_ADMIN" | "ADMIN" | "AGENT") ?? "AGENT";
      }
      return session;
    },
  },
};
