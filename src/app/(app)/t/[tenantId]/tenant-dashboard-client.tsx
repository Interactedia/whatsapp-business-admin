"use client";

import Link from "next/link";
import { useI18n } from "@/components/i18n/language-provider";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  ChevronRight,
  TriangleAlert,
  MessageSquare,
  LayoutTemplate,
  Megaphone,
  Users,
  Workflow,
  ScrollText,
} from "lucide-react";

const ICON_MAP = {
  MessageSquare,
  LayoutTemplate,
  Megaphone,
  Users,
  Workflow,
  ScrollText,
} as const;

type IconName = keyof typeof ICON_MAP;

type Tile = {
  label: string;
  value: number | string;
  sub: string;
  href: string;
  icon: IconName;
  visible: boolean;
};

type Props = {
  tiles: Tile[];
  isAdmin: boolean;
  wabaConnected: boolean;
  tenantId: string;
  tenantName: string;
};

export function TenantDashboardClient({
  tiles,
  isAdmin,
  wabaConnected,
  tenantId,
  tenantName,
}: Props) {
  const { t } = useI18n();

  // ponytail: description uses direct interpolation; key is only for the shell label.
  const description =
    t("dashboard.description", `${tenantName} activity summary.`).replace("{tenant}", tenantName);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t("dashboard.title", "Dashboard")}
        description={description}
      />
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        <div className="space-y-4 p-4 sm:p-6">
          {/* WhatsApp connection notice — only actionable by ADMIN (Settings is admin-only). */}
          {isAdmin && !wabaConnected && (
            <div
              role="alert"
              className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4 dark:border-amber-900/30 dark:bg-amber-950/30"
            >
              <div className="flex items-start gap-3">
                <TriangleAlert
                  className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-500"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                    {t("dashboard.waNotConnected.title", "WhatsApp no está conectado")}
                  </p>
                  <p className="text-xs text-amber-800 dark:text-amber-300">
                    {t(
                      "dashboard.waNotConnected.desc",
                      "Configura tu cuenta de WhatsApp Business para comenzar a recibir y enviar mensajes.",
                    )}
                  </p>
                </div>
              </div>
              <Button asChild size="sm" className="shrink-0">
                <Link href={`/t/${tenantId}/settings`}>
                  {t("dashboard.waNotConnected.action", "Ir a configuración")}
                </Link>
              </Button>
            </div>
          )}

          {/* Metric shortcuts — presentation only; queries and values unchanged. */}
          <div className="grid grid-cols-1 gap-3 min-[430px]:grid-cols-2 lg:grid-cols-3">
            {tiles.map((tile) => {
              const Icon = ICON_MAP[tile.icon];
              return (
                <Link
                  key={tile.label}
                  href={tile.href}
                  aria-label={`${tile.label}: ${tile.value}. ${tile.sub}`}
                  className="group block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <Card className="h-full border-border bg-card text-card-foreground transition-all duration-150 group-hover:-translate-y-0.5 group-hover:border-primary/30 group-hover:shadow-md">
                    <CardContent className="flex items-start justify-between gap-3 p-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10"
                            aria-hidden="true"
                          >
                            <Icon className="h-4 w-4 text-primary" />
                          </span>
                          <p className="truncate text-sm font-medium text-muted-foreground">
                            {tile.label}
                          </p>
                        </div>
                        <div className="mt-3 text-[28px] font-semibold leading-none tabular-nums text-foreground">
                          {tile.value}
                        </div>
                        <p className="mt-1.5 text-xs text-muted-foreground">{tile.sub}</p>
                      </div>
                      <ChevronRight
                        className="mt-1 h-4 w-4 shrink-0 text-muted-foreground/50 transition-all duration-150 group-hover:translate-x-0.5 group-hover:text-primary"
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
