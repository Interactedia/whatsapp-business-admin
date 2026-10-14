import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { RecentActivitySection } from "@/app/(app)/admin/recent-activity";
import { Building2, UserCog, Users, MessageSquare, ListChecks, ArrowRight } from "lucide-react";

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
    { label: "Conversations", value: conversationCount, href: "/admin/tenants", icon: MessageSquare },
  ];

  const adminLinks = [
    { label: "Manage tenants & memberships", href: "/admin/tenants", icon: Building2 },
    { label: "Manage users", href: "/admin/users", icon: UserCog },
    { label: "Queues & Outbox", href: "/admin/queue-observability", icon: ListChecks },
  ];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="System Administration"
        description="Platform-wide overview. Manage tenants and users from the administration section."
      />

      <div className="flex-1 overflow-auto p-4 sm:p-6">
        {/* Metrics Grid — 3 columns desktop, 2 tablet, 1 mobile */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {stats.map((stat) => {
            const Icon = stat.icon;
            return (
              <Link key={stat.label} href={stat.href}>
                <Card className="h-full transition-all hover:border-primary/50 hover:shadow-sm focus-within:ring-2 focus-within:ring-primary/20">
                  <CardContent className="flex items-center gap-4 p-4">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                      <Icon className="h-5 w-5 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-2xl font-semibold tabular-nums leading-none">{stat.value}</p>
                      <p className="mt-1 text-sm text-muted-foreground">{stat.label}</p>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>

        {/* Administration Section */}
        <div className="mt-6">
          <h2 className="mb-3 text-sm font-semibold text-foreground">Administration</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {adminLinks.map((link) => {
              const Icon = link.icon;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm font-medium text-foreground transition-all hover:border-primary/50 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{link.label}</span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </Link>
              );
            })}
          </div>
        </div>

        {/* Recent Activity — reuses /api/logs (same source as /logs tabs) */}
        <div className="mt-6">
          <RecentActivitySection />
        </div>
      </div>
    </div>
  );
}
