import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

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
 * Settings — requires explicit tenant selection.
 * Redirects to tenant selector if no tenant context is established.
 */
export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session?.user.role !== "ADMIN") redirect("/");

  const memberships = await getMemberships(session.user.id);

  // No memberships or outside tenant context: redirect to tenant selection
  if (memberships.length === 0) {
    redirect("/inbox");
  }

  // Redirect to tenant-scoped settings
  redirect(`/t/${memberships[0].tenantId}/settings`);
}
