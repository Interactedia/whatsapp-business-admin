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
 * Root entry — resolves the user's tenant context and sends them to the
 * tenant-scoped Dashboard as the first screen.
 * - Zero memberships: show the empty state.
 * - One membership: auto-redirect to that tenant's Dashboard.
 * - Multiple memberships: show the selection screen.
 */
export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const memberships = await getMemberships(session.user.id);

  if (memberships.length === 0) {
    return <TenantSelector memberships={[]} resource="conversations" />;
  }

  if (memberships.length === 1) {
    // Single membership: land on the tenant Dashboard (the first screen).
    redirect(`/t/${memberships[0].tenantId}`);
  }

  // Multiple memberships: pick before entering the workspace.
  return <TenantSelector memberships={memberships} resource="conversations" />;
}
