import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { TenantSelector } from "@/components/tenant/tenant-selector";
import { LogsClient } from "@/app/(app)/logs/logs-client";

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

export default async function TenantLogsPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "ADMIN") redirect("/");

  const { tenantId } = await params;

  const membership = await verifyMembership(session.user.id, tenantId);
  if (!membership) {
    const memberships = await getMemberships(session.user.id);
    return <TenantSelector memberships={memberships} />;
  }

  return <LogsClient />;
}
