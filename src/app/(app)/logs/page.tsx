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
 * Logs — requires explicit tenant selection.
 * Redirects to tenant selector if no tenant context is established.
 */
export default async function LogsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "ADMIN") redirect("/");

  const memberships = await getMemberships(session.user.id);

  if (memberships.length === 0) {
    redirect("/inbox");
  }

  redirect(`/t/${memberships[0].tenantId}/logs`);
}
