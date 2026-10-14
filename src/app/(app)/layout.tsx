import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { AppShellClient } from "@/components/shell/app-shell-client";

async function getMemberships(userId: string) {
  return prisma.tenantMembership.findMany({
    where: {
      userId,
      user: { active: true },
    },
    select: {
      id: true,
      tenantId: true,
      tenant: {
        select: { id: true, name: true },
      },
    },
    orderBy: { tenant: { name: "asc" } },
  });
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const memberships = await getMemberships(session.user.id);

  const wabaConnected = false;

  return (
    <AppShellClient
      user={{
        name: session.user.name || session.user.email || "User",
        email: session.user.email || "",
        role: session.user.role,
      }}
      memberships={memberships}
      wabaConnected={wabaConnected}
      phoneNumber={null}
    >
      {children}
    </AppShellClient>
  );
}
