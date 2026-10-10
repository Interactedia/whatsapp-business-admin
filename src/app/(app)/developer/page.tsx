import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { DeveloperClient } from "./developer-client";

export default async function DeveloperPage() {
  const session = await auth();
  if (session?.user.role !== "ADMIN") redirect("/");

  // Prefer the live request host so the docs show a working base URL.
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host");
  const proto = h.get("x-forwarded-proto") || "http";
  const baseUrl = host ? `${proto}://${host}` : process.env.APP_URL || "http://localhost:3000";

  const memberships = await prisma.tenantMembership.findMany({
    where: { userId: session.user.id, user: { active: true } },
    select: { tenantId: true, tenant: { select: { id: true, name: true } } },
  });

  return (
    <DeveloperClient
      baseUrl={baseUrl}
      tenants={memberships.map((m) => ({ id: m.tenant.id, name: m.tenant.name }))}
    />
  );
}
