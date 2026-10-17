import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getTenantWabaConfig, isConfigured } from "@/lib/settings";
import { TenantSelector } from "@/components/tenant/tenant-selector";
import { TenantDashboardClient } from "@/app/(app)/t/[tenantId]/tenant-dashboard-client";

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

  const [stats, wabaCfg] = await Promise.all([
    getTenantStats(tenantId),
    getTenantWabaConfig(tenantId),
  ]);

  const tenant = membership.tenant;
  const isAdmin = session.user.role === "ADMIN";
  // Reuse the canonical connection state (same criterion as
  // /api/tenants/:id/settings → `connected` and the sidebar footer).
  const wabaConnected = wabaCfg ? isConfigured(wabaCfg) : false;

  const tiles = [
    {
      label: "Conversations",
      value: stats.conversations,
      sub: `${stats.unread} unread`,
      href: `/t/${tenantId}/conversations`,
      icon: "MessageSquare" as const,
      visible: true,
    },
    {
      label: "Contacts",
      value: stats.contacts,
      sub: "in address book",
      href: `/t/${tenantId}/contacts`,
      icon: "Users" as const,
      visible: true,
    },
    {
      label: "Templates",
      value: stats.templates,
      sub: `${stats.approved} approved`,
      href: `/t/${tenantId}/templates`,
      icon: "LayoutTemplate" as const,
      visible: isAdmin,
    },
    {
      label: "Flows",
      value: stats.flows,
      sub: "active",
      href: `/t/${tenantId}/flows`,
      icon: "Workflow" as const,
      visible: isAdmin,
    },
    {
      label: "Broadcasts",
      value: stats.broadcasts,
      sub: "campaigns",
      href: `/t/${tenantId}/broadcasts`,
      icon: "Megaphone" as const,
      visible: isAdmin,
    },
    {
      label: "Submissions",
      value: "—",
      sub: "flow entries",
      href: `/t/${tenantId}/submissions`,
      icon: "ScrollText" as const,
      visible: true,
    },
  ].filter((t) => t.visible);

  return (
    <TenantDashboardClient
      tiles={tiles}
      isAdmin={isAdmin}
      wabaConnected={wabaConnected}
      tenantId={tenantId}
      tenantName={tenant.name}
    />
  );
}
