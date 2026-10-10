import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { TenantSelector } from "@/components/tenant/tenant-selector";

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

export default async function InboxPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const memberships = await getMemberships(session.user.id);

  // Explicit tenant selection required — never auto-select
  return <TenantSelector memberships={memberships} resource="conversations" />;
}
