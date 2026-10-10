import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe auth config (no DB, no Node-only deps) shared by the middleware and
 * the full server config in `auth.ts`. Providers are added in `auth.ts`.
 */
const protectedTenantReadPattern =
  /^\/api\/tenants\/[^/]+\/(?:contacts|conversations)\/[^/]+$/;
const protectedTenantListPattern =
  /^\/api\/tenants\/[^/]+\/(?:contacts|conversations)\/?$/;
const protectedTenantMessageHistoryPattern =
  /^\/api\/tenants\/[^/]+\/conversations\/[^/]+\/messages\/?$/;

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
        if (isLoggedIn) return Response.redirect(new URL("/", nextUrl));
        return true;
      }
      if (
        !isLoggedIn &&
        request.method === "GET" &&
        (protectedTenantReadPattern.test(nextUrl.pathname) ||
          protectedTenantListPattern.test(nextUrl.pathname) ||
          protectedTenantMessageHistoryPattern.test(nextUrl.pathname))
      ) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      return isLoggedIn;
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
        session.user.role = (token.role as "ADMIN" | "AGENT") ?? "AGENT";
      }
      return session;
    },
  },
};
