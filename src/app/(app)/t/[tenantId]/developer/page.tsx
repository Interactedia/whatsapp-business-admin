import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { TenantSelector } from "@/components/tenant/tenant-selector";
import { DeveloperClient } from "@/app/(app)/developer/developer-client";

async function getMemberships(userId: string) {
  return prisma.tenantMembership.findMany({
    where: {
      userId,
      user: { active: true },
    },
    select: {
      id: true,
      tenantId: true,
      tenant: { select: { id: true, name: true } },
    },
  });
}

async function verifyMembership(userId: string, tenantId: string) {
  const membership = await prisma.tenantMembership.findUnique({
    where: { userId_tenantId: { userId, tenantId } },
    select: { id: true, user: { select: { active: true } }, tenant: { select: { id: true, name: true } } },
  });
  if (!membership?.user.active || !membership.tenant) return null;
  return membership;
}

export default async function TenantDeveloperPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { tenantId } = await params;

  const membership = await verifyMembership(session.user.id, tenantId);
  if (!membership) {
    const memberships = await getMemberships(session.user.id);
    return <TenantSelector memberships={memberships} />;
  }

  // Build base URL for API docs
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host");
  const proto = h.get("x-forwarded-proto") || "http";
  const baseUrl = host ? `${proto}://${host}` : process.env.APP_URL || "http://localhost:3000";

  const allMemberships = await getMemberships(session.user.id);

  return (
    <DeveloperClient
      baseUrl={baseUrl}
      tenants={allMemberships.map((m) => ({ id: m.tenant.id, name: m.tenant.name }))}
    />
  );
}
