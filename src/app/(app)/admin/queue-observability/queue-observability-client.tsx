"use client";

import { Fragment } from "react";
import { Activity, AlertTriangle, Database, ListChecks } from "lucide-react";
import { useI18n } from "@/components/i18n/language-provider";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
// Type-only imports: erased at compile time, no server code reaches the client bundle.
import type { QueueObservabilitySummary } from "@/lib/queue/observability";
import type { OutboxObservabilityResult } from "@/lib/outbox/observability";

type Props = {
  queues: QueueObservabilitySummary;
  database: OutboxObservabilityResult;
};

export function QueueObservabilityClient({ queues, database }: Props) {
  const { t } = useI18n();

  const outbox = database.available ? database.outbox : null;
  const attempts = database.available ? database.outboundAttempts : [];
  const uncertain = attempts.find((item) => item.state === "UNCERTAIN")?.count ?? 0;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t("admin.queue.title", "Queue & Outbox Observability")}
        description={t(
          "admin.queue.description",
          "Read-only operational signals for BullMQ queues, outbox publication, and outbound send outcomes.",
        )}
      />

      <div className="flex-1 overflow-auto p-4 sm:p-6">
        {/* Operational Summary Cards */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {/* Queue Metrics */}
          <div className="rounded-lg border bg-card p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <ListChecks className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t("admin.queue.card.queueMetrics", "Queue metrics")}
                </p>
                <div className="mt-1">
                  <Badge variant={queues.available ? "success" : "warning"} className="font-normal">
                    {queues.available
                      ? t("admin.queue.badge.available", "available")
                      : t("admin.queue.badge.unavailable", "unavailable")}
                  </Badge>
                </div>
              </div>
            </div>
          </div>

          {/* Outbox Terminal */}
          <div className="rounded-lg border bg-card p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <Database className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t("admin.queue.card.outboxTerminal", "Outbox terminal")}
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {outbox ? outbox.terminal : "—"}
                </p>
              </div>
            </div>
          </div>

          {/* UNCERTAIN Attempts */}
          <div className="rounded-lg border bg-card p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/10">
                <AlertTriangle className="h-5 w-5 text-amber-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t("admin.queue.card.uncertainAttempts", "UNCERTAIN attempts")}
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {database.available ? uncertain : "—"}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* BullMQ Queues Table */}
        <div className="mt-6">
          <div className="mb-3 flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">
              {t("admin.queue.section.bullmqQueues", "BullMQ queues")}
            </h2>
          </div>
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">{t("admin.queue.table.queue", "Queue")}</TableHead>
                  <TableHead className="text-right">{t("admin.queue.table.waiting", "Waiting")}</TableHead>
                  <TableHead className="text-right">{t("admin.queue.table.active", "Active")}</TableHead>
                  <TableHead className="text-right">{t("admin.queue.table.delayed", "Delayed")}</TableHead>
                  <TableHead className="text-right">{t("admin.queue.table.completed", "Completed")}</TableHead>
                  <TableHead className="text-right">{t("admin.queue.table.failed", "Failed")}</TableHead>
                  <TableHead className="pr-4 text-center">{t("admin.queue.table.status", "Status")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queues.queues.map((queue) => (
                  <TableRow key={queue.name} className="group hover:bg-accent/50">
                    {queue.available ? (
                      <>
                        <TableCell className="pl-4 py-3 font-medium">{queue.name}</TableCell>
                        <TableCell className="py-3 text-right tabular-nums">{queue.result.counts.waiting}</TableCell>
                        <TableCell className="py-3 text-right tabular-nums">{queue.result.counts.active}</TableCell>
                        <TableCell className="py-3 text-right tabular-nums">{queue.result.counts.delayed}</TableCell>
                        <TableCell className="py-3 text-right tabular-nums">{queue.result.counts.completed}</TableCell>
                        <TableCell className="py-3 text-right tabular-nums">{queue.result.counts.failed}</TableCell>
                        <TableCell className="pr-4 py-3 text-center">
                          <Badge
                            variant={queue.result.isPaused ? "warning" : "success"}
                            className="font-normal"
                          >
                            {queue.result.isPaused
                              ? t("admin.queue.badge.paused", "paused")
                              : t("admin.queue.badge.running", "running")}
                          </Badge>
                        </TableCell>
                      </>
                    ) : (
                      <TableCell colSpan={7} className="pl-4 py-3 text-sm text-muted-foreground">
                        {t("admin.queue.table.unavailable", "unavailable")} ({queue.error})
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>

        {/* PostgreSQL Outbox and Meta Outcomes */}
        <div className="mt-6">
          <div className="mb-3 flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">
              {t("admin.queue.section.outboxAndMeta", "PostgreSQL outbox and Meta send outcomes")}
            </h2>
          </div>

          {database.available && outbox ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {/* Outbox Publication State */}
              <div className="rounded-lg border bg-card p-4">
                <h3 className="mb-3 text-sm font-medium text-foreground">
                  {t("admin.queue.outbox.title", "Outbox publication state")}
                </h3>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">{t("admin.queue.outbox.pending", "Pending")}</dt>
                  <dd className="text-right font-medium tabular-nums">{outbox.pending}</dd>
                  <dt className="text-muted-foreground">{t("admin.queue.outbox.claimed", "Claimed")}</dt>
                  <dd className="text-right font-medium tabular-nums">{outbox.claimed}</dd>
                  <dt className="text-muted-foreground">{t("admin.queue.outbox.retryable", "Retryable")}</dt>
                  <dd className="text-right font-medium tabular-nums">{outbox.retryable}</dd>
                  <dt className="text-muted-foreground">{t("admin.queue.outbox.published", "Published")}</dt>
                  <dd className="text-right font-medium tabular-nums">{outbox.published}</dd>
                  <dt className="text-muted-foreground">{t("admin.queue.outbox.terminal", "Terminal")}</dt>
                  <dd className="text-right font-medium tabular-nums">{outbox.terminal}</dd>
                  <dt className="text-muted-foreground">{t("admin.queue.outbox.expiredLeases", "Expired leases")}</dt>
                  <dd className="text-right font-medium tabular-nums">{outbox.expiredLeases}</dd>
                </dl>
              </div>

              {/* Outbound Send Attempt State */}
              <div className="rounded-lg border bg-card p-4">
                <h3 className="mb-3 text-sm font-medium text-foreground">
                  {t("admin.queue.attempts.title", "Outbound send attempt state")}
                </h3>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  {attempts.map((item) => (
                    <Fragment key={item.state}>
                      <dt className="text-muted-foreground">{item.state}</dt>
                      <dd className="text-right font-medium tabular-nums">{item.count}</dd>
                    </Fragment>
                  ))}
                </dl>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4">
              <p className="text-sm text-destructive">
                {t("admin.queue.dbUnavailable", "database metrics unavailable")}
              </p>
            </div>
          )}
        </div>

        {/* Operational Warning */}
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/50">
          <div className="flex gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="text-sm text-amber-800 dark:text-amber-200">
              <p className="font-medium">{t("admin.queue.disclaimer.title", "Meta delivery evidence disclaimer")}</p>
              <p className="mt-1 text-amber-700/80 dark:text-amber-300/80">
                {t(
                  "admin.queue.disclaimer.body",
                  "BullMQ completion and outbox publication are not Meta delivery evidence. UNCERTAIN means the external Meta outcome is unknown and must not be treated as FAILED or automatically retryable.",
                )}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
