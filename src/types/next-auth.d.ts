import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: "SYSTEM_ADMIN" | "ADMIN" | "AGENT";
    } & DefaultSession["user"];
  }

  interface User {
    role?: "SYSTEM_ADMIN" | "ADMIN" | "AGENT";
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: "SYSTEM_ADMIN" | "ADMIN" | "AGENT";
  }
}
