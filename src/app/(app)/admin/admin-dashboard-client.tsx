"use client";

import Link from "next/link";
import { ArrowRight, Building2, ListChecks, MessageSquare, UserCog, Users } from "lucide-react";
import { useI18n } from "@/components/i18n/language-provider";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { RecentActivitySection } from "@/app/(app)/admin/recent-activity";

type Stat = {
  key: "tenants" | "users" | "activeUsers" | "memberships" | "conversations";
  value: number;
  href: string;
};

type AdminLink = {
  key: "manageTenants" | "manageUsers" | "queuesOutbox";
  href: string;
};

type Props = {
  stats: Stat[];
  adminLinks: AdminLink[];
};

// Icons resolved client-side so page.tsx passes plain serializable data only.
const STAT_ICONS: Record<Stat["key"], React.ElementType> = {
  tenants: Building2,
  users: UserCog,
  activeUsers: Users,
  memberships: Users,
  conversations: MessageSquare,
};

const LINK_ICONS: Record<AdminLink["key"], React.ElementType> = {
  manageTenants: Building2,
  manageUsers: UserCog,
  queuesOutbox: ListChecks,
};

export function AdminDashboardClient({ stats, adminLinks }: Props) {
  const { t } = useI18n();

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t("admin.title", "System Administration")}
        description={t(
          "admin.description",
          "Platform-wide overview. Manage tenants and users from the administration section.",
        )}
      />

      <div className="flex-1 overflow-auto p-4 sm:p-6">
        {/* Metrics Grid — 3 columns desktop, 2 tablet, 1 mobile */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {stats.map((stat) => {
            const Icon = STAT_ICONS[stat.key];
            return (
              <Link key={stat.key} href={stat.href}>
                <Card className="h-full transition-all hover:border-primary/50 hover:shadow-sm focus-within:ring-2 focus-within:ring-primary/20">
                  <CardContent className="flex items-center gap-4 p-4">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                      <Icon className="h-5 w-5 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-2xl font-semibold tabular-nums leading-none">{stat.value}</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {t(`admin.stats.${stat.key}`, stat.key)}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>

        {/* Administration Section */}
        <div className="mt-6">
          <h2 className="mb-3 text-sm font-semibold text-foreground">
            {t("admin.section.administration", "Administration")}
          </h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {adminLinks.map((link) => {
              const Icon = LINK_ICONS[link.key];
              return (
                <Link
                  key={link.key}
                  href={link.href}
                  className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm font-medium text-foreground transition-all hover:border-primary/50 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">
                    {t(`admin.link.${link.key}`, link.key)}
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
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
