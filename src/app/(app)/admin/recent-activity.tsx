"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Inbox, Loader2, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { formatInboxTimestamp } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/components/i18n/language-provider";

/**
 * Recent Activity section for the SYSTEM_ADMIN dashboard.
 * Reuses the existing /api/logs feed (same source as the /logs tabs):
 *   type=api     → outbound Graph API calls (ApiLog)
 *   type=webhook → inbound webhook events (WebhookEvent)
 * Only whitelisted display fields are rendered; request/response bodies are
 * never shown. Server-side authorization lives in /api/logs (SYSTEM_ADMIN).
 */

type TenantLabel = { id: string; name: string } | null;

type ApiItem = {
  id: string;
  tenantId: string | null;
  tenant?: TenantLabel;
  method: string;
  endpoint: string;
  ok: boolean;
  responseStatus: number | null;
  createdAt: string;
};

type WebhookItem = {
  id: string;
  tenantId: string | null;
  tenant?: TenantLabel;
  eventSummary: string | null;
  signatureValid: boolean;
  processedOk: boolean;
  createdAt: string;
};

type Feed<T> = { items: T[] };

// Same tenantLabel semantics as /logs — do not invent fields.
function tenantLabel(item: { tenantId: string | null; tenant?: TenantLabel }) {
  if (item.tenant) return `${item.tenant.name} (${item.tenant.id})`;
  return item.tenantId ? item.tenantId : "Sin resolver";
}

function hasTenant(item: { tenantId: string | null; tenant?: TenantLabel }) {
  return Boolean(item.tenant || item.tenantId);
}

function SkeletonRows() {
  return (
    <ul aria-hidden className="divide-y">
      {Array.from({ length: 5 }).map((_, i) => (
        <li key={i} className="flex items-center gap-2.5 px-4 py-2.5">
          <div className="h-3 w-14 shrink-0 animate-pulse rounded bg-muted" />
          <div className="h-3 w-12 shrink-0 animate-pulse rounded bg-muted" />
          <div className="h-3 flex-1 animate-pulse rounded bg-muted" />
          <div className="h-3 w-8 shrink-0 animate-pulse rounded bg-muted" />
        </li>
      ))}
    </ul>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
        <Inbox className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium text-foreground">{text}</p>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div role="alert" className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="h-5 w-5 text-destructive" />
      </div>
      <p className="text-sm font-medium text-foreground">{t("admin.recentActivity.error", "Error al consultar")}</p>
      <p className="max-w-xs text-xs text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t("admin.recentActivity.retry", "Reintentar")}
      </Button>
    </div>
  );
}

function StaleBanner({ message }: { message: string }) {
  const { t } = useI18n();
  return (
    <div role="status" className="border-b bg-destructive/5 px-4 py-2 text-xs text-destructive">
      {t("admin.recentActivity.staleBanner", "Sin actualizar: {message}. Mostrando últimos datos válidos.").replace(
        "{message}",
        message,
      )}
    </div>
  );
}

function Panel({
  title,
  href,
  linkLabel,
  staleError,
  children,
}: {
  title: string;
  href: string;
  linkLabel: string;
  staleError: string | null;
  children: React.ReactNode;
}) {
  return (
    // min-w-0: grid items default to min-width:auto — long mono endpoints would
    // widen the track and cause horizontal overflow on mobile.
    <Card className="min-w-0">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <Link href={href} className="shrink-0 text-xs font-medium text-primary hover:underline">
          {linkLabel}
        </Link>
      </div>
      {staleError && <StaleBanner message={staleError} />}
      {children}
    </Card>
  );
}

export function RecentActivitySection() {
  const { t } = useI18n();

  const apiQuery = useQuery({
    queryKey: ["admin-recent-activity", "api"],
    queryFn: () => apiFetch<Feed<ApiItem>>("/api/logs?type=api&pageSize=5&page=1"),
  });
  const webhookQuery = useQuery({
    queryKey: ["admin-recent-activity", "webhook"],
    queryFn: () => apiFetch<Feed<WebhookItem>>("/api/logs?type=webhook&pageSize=5&page=1"),
  });

  const refetching = apiQuery.isFetching || webhookQuery.isFetching;
  const lastUpdated = Math.max(apiQuery.dataUpdatedAt, webhookQuery.dataUpdatedAt);

  function refresh() {
    void apiQuery.refetch();
    void webhookQuery.refetch();
  }

  const apiError = apiQuery.error instanceof Error ? apiQuery.error.message : null;
  const webhookError = webhookQuery.error instanceof Error ? webhookQuery.error.message : null;

  return (
    <section aria-labelledby="recent-activity-title">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="recent-activity-title" className="text-base font-semibold text-foreground">
            {t("admin.recentActivity.title", "Actividad reciente")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t(
              "admin.recentActivity.description",
              "Últimas llamadas API y eventos de Webhooks registrados en la plataforma.",
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated > 0 && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {t("admin.recentActivity.lastUpdated", "Actualizado {time}").replace(
                "{time}",
                formatInboxTimestamp(lastUpdated),
              )}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={refresh} disabled={refetching}>
            {refetching ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {t("admin.recentActivity.refresh", "Actualizar")}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* API calls panel */}
        <Panel
          title={t("admin.recentActivity.api.title", "Últimas llamadas API")}
          href="/logs?tab=api"
          linkLabel={t("admin.recentActivity.api.link", "Ver todos los logs →")}
          staleError={apiQuery.data ? apiError : null}
        >
          {apiQuery.isLoading ? (
            <div aria-busy="true" aria-label={t("admin.recentActivity.api.loading", "Cargando llamadas API")}>
              <SkeletonRows />
            </div>
          ) : apiQuery.data ? (
            apiQuery.data.items.length === 0 ? (
              <EmptyState text={t("admin.recentActivity.api.empty", "Sin llamadas API registradas.")} />
            ) : (
              <ul className="divide-y">
                {apiQuery.data.items.map((log) => (
                  <li key={log.id} className="px-4 py-2">
                    <div className="flex items-center gap-2.5 text-[13px]">
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {formatInboxTimestamp(log.createdAt)}
                      </span>
                      <Badge variant="outline" className="shrink-0 font-mono text-[11px] font-medium">
                        {log.method}
                      </Badge>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={log.endpoint}>
                        {log.endpoint}
                      </span>
                      <Badge
                        variant={log.ok ? "success" : "destructive"}
                        className="shrink-0 font-normal tabular-nums"
                      >
                        {log.responseStatus ?? "—"}
                      </Badge>
                    </div>
                    {hasTenant(log) && (
                      <div className="mt-0.5 truncate text-xs text-muted-foreground" title={tenantLabel(log)}>
                        {tenantLabel(log)}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )
          ) : (
            <ErrorState message={apiError ?? t("admin.recentActivity.error", "Error al consultar")} onRetry={() => void apiQuery.refetch()} />
          )}
        </Panel>

        {/* Webhooks panel — same source and semantics as the /logs Webhooks tab */}
        <Panel
          title={t("admin.recentActivity.webhook.title", "Últimos Webhooks")}
          href="/logs?tab=webhook"
          linkLabel={t("admin.recentActivity.webhook.link", "Ver todos los webhooks →")}
          staleError={webhookQuery.data ? webhookError : null}
        >
          {webhookQuery.isLoading ? (
            <div aria-busy="true" aria-label={t("admin.recentActivity.webhook.loading", "Cargando webhooks")}>
              <SkeletonRows />
            </div>
          ) : webhookQuery.data ? (
            webhookQuery.data.items.length === 0 ? (
              <EmptyState text={t("admin.recentActivity.webhook.empty", "Sin webhooks registrados.")} />
            ) : (
              <ul className="divide-y">
                {webhookQuery.data.items.map((ev) => (
                  <li key={ev.id} className="px-4 py-2">
                    <div className="flex items-center gap-2.5 text-[13px]">
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {formatInboxTimestamp(ev.createdAt)}
                      </span>
                      <span className="min-w-0 flex-1 truncate" title={ev.eventSummary ?? undefined}>
                        {ev.eventSummary ?? "—"}
                      </span>
                      {!ev.signatureValid && (
                        <Badge variant="warning" className="shrink-0 font-normal">
                          {t("admin.recentActivity.unverified", "unverified")}
                        </Badge>
                      )}
                      <Badge
                        variant={ev.processedOk ? "success" : "destructive"}
                        className="shrink-0 font-normal"
                      >
                        {ev.processedOk
                          ? t("admin.recentActivity.status.ok", "ok")
                          : t("admin.recentActivity.status.error", "error")}
                      </Badge>
                    </div>
                    {hasTenant(ev) && (
                      <div className="mt-0.5 truncate text-xs text-muted-foreground" title={tenantLabel(ev)}>
                        {tenantLabel(ev)}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )
          ) : (
            <ErrorState message={webhookError ?? t("admin.recentActivity.error", "Error al consultar")} onRetry={() => void webhookQuery.refetch()} />
          )}
        </Panel>
      </div>
    </section>
  );
}
