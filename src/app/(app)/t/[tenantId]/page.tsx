import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getTenantWabaConfig, isConfigured } from "@/lib/settings";
import { TenantSelector } from "@/components/tenant/tenant-selector";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MessageSquare, LayoutTemplate, Megaphone, Users, Workflow, ScrollText, ChevronRight, TriangleAlert } from "lucide-react";

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
        title="Dashboard"
        description="Resumen de actividad del tenant."
        size="large"
      />
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        <div className="space-y-4 p-4">
          {/* WhatsApp connection notice — only actionable by ADMIN (Settings is admin-only). */}
          {isAdmin && !wabaConnected && (
            <div
              role="status"
              className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <div className="flex items-start gap-3">
                <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-amber-900">WhatsApp no está conectado</p>
                  <p className="text-xs text-amber-800">
                    Configura tu cuenta de WhatsApp Business para comenzar a recibir y enviar mensajes.
                  </p>
                </div>
              </div>
              <Button asChild size="sm" className="shrink-0">
                <Link href={`/t/${tenantId}/settings`}>Ir a configuración</Link>
              </Button>
            </div>
          )}

          {/* Metric shortcuts — presentation only; queries and values unchanged. */}
          <div className="grid grid-cols-1 gap-3 min-[430px]:grid-cols-2 lg:grid-cols-3">
            {tiles.map((tile) => {
              const Icon = tile.icon;
              return (
                <Link
                  key={tile.label}
                  href={tile.href}
                  aria-label={`${tile.label}: ${tile.value}. ${tile.sub}`}
                  className="group block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-slate-50"
                >
                  <Card className="h-full border-slate-200 bg-white transition-all duration-150 group-hover:-translate-y-0.5 group-hover:border-primary/30 group-hover:shadow-md">
                    <CardContent className="flex items-start justify-between gap-3 p-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10" aria-hidden="true">
                            <Icon className="h-4 w-4 text-primary" />
                          </span>
                          <p className="truncate text-sm font-medium text-slate-600">{tile.label}</p>
                        </div>
                        <div className="mt-3 text-[28px] font-semibold leading-none tabular-nums text-slate-900">
                          {tile.value}
                        </div>
                        <p className="mt-1.5 text-xs text-slate-500">{tile.sub}</p>
                      </div>
                      <ChevronRight
                        className="mt-1 h-4 w-4 shrink-0 text-slate-300 transition-all duration-150 group-hover:translate-x-0.5 group-hover:text-primary"
                        aria-hidden="true"
                      />
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
