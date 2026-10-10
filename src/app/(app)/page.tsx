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

/**
 * Dashboard — requires explicit tenant selection.
 * Redirects to tenant selector if no tenant context is established.
 * Once a tenant is selected, shows tenant-scoped stats.
 */
export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const memberships = await getMemberships(session.user.id);

  // No memberships: show empty state
  if (memberships.length === 0) {
    return <TenantSelector memberships={[]} />;
  }

  // One membership: auto-redirect to that tenant
  if (memberships.length === 1) {
    redirect(`/t/${memberships[0].tenantId}/conversations`);
  }

  // Multiple memberships: show selection screen
  return <TenantSelector memberships={memberships} resource="conversations" />;
}
