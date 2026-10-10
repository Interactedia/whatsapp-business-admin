import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { TenantSelector } from "@/components/tenant/tenant-selector";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MessageSquare, LayoutTemplate, Megaphone, Users, Workflow, ScrollText } from "lucide-react";

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
    select: {
      id: true,
      user: { select: { active: true } },
      tenant: { select: { id: true, name: true } },
    },
  });
  if (!membership?.user.active || !membership.tenant) return null;
  return membership;
}

async function getTenantStats(tenantId: string) {
  const [conversations, unread, templates, approved, contacts, broadcasts, flows] = await Promise.all([
    prisma.conversation.count({ where: { tenantId } }),
    prisma.conversation.aggregate({ where: { tenantId }, _sum: { unreadCount: true } }),
    prisma.template.count({ where: { tenantId } }),
    prisma.template.count({ where: { tenantId, status: "APPROVED" } }),
    prisma.contact.count({ where: { tenantId } }),
    prisma.broadcast.count({ where: { tenantId } }),
    prisma.flow.count({ where: { tenantId } }),
  ]);
  return {
    conversations,
    unread: unread._sum.unreadCount ?? 0,
    templates,
    approved,
    contacts,
    broadcasts,
    flows,
  };
}

export default async function TenantDashboardPage({
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

  const stats = await getTenantStats(tenantId);
  const tenant = membership.tenant;
  const isAdmin = session.user.role === "ADMIN";

  const tiles = [
    { label: "Conversations", value: stats.conversations, sub: `${stats.unread} unread`, href: `/t/${tenantId}/conversations`, icon: MessageSquare, visible: true },
    { label: "Contacts", value: stats.contacts, sub: "in address book", href: `/t/${tenantId}/contacts`, icon: Users, visible: true },
    { label: "Templates", value: stats.templates, sub: `${stats.approved} approved`, href: `/t/${tenantId}/templates`, icon: LayoutTemplate, visible: isAdmin },
    { label: "Flows", value: stats.flows, sub: "active", href: `/t/${tenantId}/flows`, icon: Workflow, visible: isAdmin },
    { label: "Broadcasts", value: stats.broadcasts, sub: "campaigns", href: `/t/${tenantId}/broadcasts`, icon: Megaphone, visible: isAdmin },
    { label: "Submissions", value: "—", sub: "flow entries", href: `/t/${tenantId}/submissions`, icon: ScrollText, visible: true },
  ].filter((t) => t.visible);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={`Welcome, ${session.user.name?.split(" ")[0] ?? "there"}`}
        description={`Overview of the ${tenant.name} workspace.`}
      />
      <div className="grid grid-cols-1 gap-3 p-3 min-[430px]:grid-cols-2 lg:grid-cols-3">
        {tiles.map((tile) => {
          const Icon = tile.icon;
          return (
            <Link key={tile.label} href={tile.href} className="group">
              <Card className="h-full transition-colors hover:bg-accent/40">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    {tile.label}
                  </CardTitle>
                  <Icon className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-semibold tabular-nums">{tile.value}</div>
                  <p className="text-xs text-muted-foreground">{tile.sub}</p>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
