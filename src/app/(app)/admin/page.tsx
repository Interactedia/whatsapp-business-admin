import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Building2, UserCog, Users, MessageSquare, ListChecks } from "lucide-react";

/**
 * System Administration Dashboard — exclusive to SYSTEM_ADMIN.
 * Platform-wide overview only; no operational tenant workspace metrics.
 */
export default async function SystemAdminDashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "SYSTEM_ADMIN") redirect("/");

  const [tenantCount, userCount, membershipCount, activeUserCount, conversationCount] = await Promise.all([
    prisma.tenant.count(),
    prisma.user.count(),
    prisma.tenantMembership.count(),
    prisma.user.count({ where: { active: true } }),
    prisma.conversation.count(),
  ]);

  const stats = [
    { label: "Tenants", value: tenantCount, href: "/admin/tenants", icon: Building2 },
    { label: "Users", value: userCount, href: "/admin/users", icon: UserCog },
    { label: "Active Users", value: activeUserCount, href: "/admin/users", icon: Users },
    { label: "Memberships", value: membershipCount, href: "/admin/tenants", icon: Users },
    { label: "Conversations (all tenants)", value: conversationCount, href: "/admin/tenants", icon: MessageSquare },
    { label: "Queues & Outbox", value: "View", href: "/admin/queue-observability", icon: ListChecks },
  ];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="System Administration"
        description="Platform-wide overview. Manage tenants and users from the administration section."
      />

      <div className="flex-1 overflow-auto p-3 sm:p-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {stats.map((stat) => {
            const Icon = stat.icon;
            return (
              <Link key={stat.label} href={stat.href}>
                <Card className="h-full transition-colors hover:border-primary/50">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      <Icon className="h-3.5 w-3.5" />
                      {stat.label}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-semibold tabular-nums">{stat.value}</div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>

        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-sm">Administration</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2 text-sm">
            <Link
              href="/admin/tenants"
              className="inline-flex items-center gap-2 rounded-md border px-3 py-2 hover:bg-accent"
            >
              <Building2 className="h-4 w-4" /> Manage tenants &amp; memberships
            </Link>
            <Link
              href="/admin/users"
              className="inline-flex items-center gap-2 rounded-md border px-3 py-2 hover:bg-accent"
            >
              <UserCog className="h-4 w-4" /> Manage users
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
