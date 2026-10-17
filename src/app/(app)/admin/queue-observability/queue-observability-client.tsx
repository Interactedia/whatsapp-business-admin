"use client";

import { Fragment } from "react";
import { useI18n } from "@/components/i18n/language-provider";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Activity, AlertTriangle, Database, ListChecks } from "lucide-react";
import type { QueueObservabilitySummary } from "@/lib/queue/observability";
import type { OutboxObservabilityResult } from "@/lib/outbox/observability";

interface QueueObservabilityClientProps {
  queues: QueueObservabilitySummary;
  database: OutboxObservabilityResult;
}

export function QueueObservabilityClient({
  queues,
  database,
}: QueueObservabilityClientProps) {
  const { t } = useI18n();

  const outbox = database.available ? database.outbox : null;
  const attempts = database.available ? database.outboundAttempts : [];
  const uncertain =
    attempts.find((item) => item.state === "UNCERTAIN")?.count ?? 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-2 border-b bg-card px-4 py-5 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:px-6 sm:py-5">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {t("queueObservability.title")}
          </h1>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {t("queueObservability.description")}
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 sm:p-6">
        {/* Operational Summary Cards */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {/* Queue Metrics */}
          <Card className="rounded-lg border bg-card text-card-foreground shadow-xs">
            <CardContent className="flex items-center gap-3 p-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <ListChecks className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t("queueObservability.queueMetrics")}
                </p>
                <div className="mt-1">
                  <Badge
                    variant={queues.available ? "success" : "warning"}
                    className="font-normal"
                  >
                    {queues.available
                      ? t("queueObservability.available")
                      : t("queueObservability.unavailable")}
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Outbox Terminal */}
          <Card className="rounded-lg border bg-card text-card-foreground shadow-xs">
            <CardContent className="flex items-center gap-3 p-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <Database className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t("queueObservability.outboxTerminal")}
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {outbox ? outbox.terminal : "—"}
                </p>
              </div>
            </CardContent>
          </Card>

          {/* UNCERTAIN Attempts */}
          <Card className="rounded-lg border bg-card text-card-foreground shadow-xs">
            <CardContent className="flex items-center gap-3 p-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/10">
                <AlertTriangle className="h-5 w-5 text-amber-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t("queueObservability.uncertainAttempts")}
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {database.available ? uncertain : "—"}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* BullMQ Queues Table */}
        <div className="mt-6">
          <div className="mb-3 flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">
              {t("queueObservability.bullmqQueues")}
            </h2>
          </div>
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">
                    {t("queueObservability.table.queue")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("queueObservability.table.waiting")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("queueObservability.table.active")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("queueObservability.table.delayed")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("queueObservability.table.completed")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("queueObservability.table.failed")}
                  </TableHead>
                  <TableHead className="pr-4 text-center">
                    {t("queueObservability.table.status")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queues.queues.map((queue) => (
                  <TableRow
                    key={queue.name}
                    className="group hover:bg-accent/50"
                  >
                    {queue.available ? (
                      <>
                        <TableCell
                          className="pl-4 py-3 font-medium"
                          data-label={t("queueObservability.table.queue")}
                        >
                          {queue.name}
                        </TableCell>
                        <TableCell
                          className="py-3 text-right tabular-nums"
                          data-label={t("queueObservability.table.waiting")}
                        >
                          {queue.result.counts.waiting}
                        </TableCell>
                        <TableCell
                          className="py-3 text-right tabular-nums"
                          data-label={t("queueObservability.table.active")}
                        >
                          {queue.result.counts.active}
                        </TableCell>
                        <TableCell
                          className="py-3 text-right tabular-nums"
                          data-label={t("queueObservability.table.delayed")}
                        >
                          {queue.result.counts.delayed}
                        </TableCell>
                        <TableCell
                          className="py-3 text-right tabular-nums"
                          data-label={t("queueObservability.table.completed")}
                        >
                          {queue.result.counts.completed}
                        </TableCell>
                        <TableCell
                          className="py-3 text-right tabular-nums"
                          data-label={t("queueObservability.table.failed")}
                        >
                          {queue.result.counts.failed}
                        </TableCell>
                        <TableCell
                          className="pr-4 py-3 text-center"
                          data-label={t("queueObservability.table.status")}
                        >
                          <Badge
                            variant={queue.result.isPaused ? "warning" : "success"}
                            className="font-normal"
                          >
                            {queue.result.isPaused
                              ? t("queueObservability.paused")
                              : t("queueObservability.running")}
                          </Badge>
                        </TableCell>
                      </>
                    ) : (
                      <TableCell
                        colSpan={7}
                        className="pl-4 py-3 text-sm text-muted-foreground"
                      >
                        {t("queueObservability.unavailable")} ({queue.error})
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
              {t("queueObservability.postgresOutbox")}
            </h2>
          </div>

          {database.available && outbox ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {/* Outbox Publication State */}
              <Card className="rounded-lg border bg-card text-card-foreground shadow-xs">
                <CardContent className="p-4">
                  <h3 className="mb-3 text-sm font-medium text-foreground">
                    {t("queueObservability.outboxPublicationState")}
                  </h3>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <dt className="text-muted-foreground">
                      {t("queueObservability.pending")}
                    </dt>
                    <dd className="text-right font-medium tabular-nums">
                      {outbox.pending}
                    </dd>
                    <dt className="text-muted-foreground">
                      {t("queueObservability.claimed")}
                    </dt>
                    <dd className="text-right font-medium tabular-nums">
                      {outbox.claimed}
                    </dd>
                    <dt className="text-muted-foreground">
                      {t("queueObservability.retryable")}
                    </dt>
                    <dd className="text-right font-medium tabular-nums">
                      {outbox.retryable}
                    </dd>
                    <dt className="text-muted-foreground">
                      {t("queueObservability.published")}
                    </dt>
                    <dd className="text-right font-medium tabular-nums">
                      {outbox.published}
                    </dd>
                    <dt className="text-muted-foreground">
                      {t("queueObservability.terminal")}
                    </dt>
                    <dd className="text-right font-medium tabular-nums">
                      {outbox.terminal}
                    </dd>
                    <dt className="text-muted-foreground">
                      {t("queueObservability.expiredLeases")}
                    </dt>
                    <dd className="text-right font-medium tabular-nums">
                      {outbox.expiredLeases}
                    </dd>
                  </dl>
                </CardContent>
              </Card>

              {/* Outbound Send Attempt State */}
              <Card className="rounded-lg border bg-card text-card-foreground shadow-xs">
                <CardContent className="p-4">
                  <h3 className="mb-3 text-sm font-medium text-foreground">
                    {t("queueObservability.outboundSendState")}
                  </h3>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    {attempts.map((item) => (
                      <Fragment key={item.state}>
                        <dt className="text-muted-foreground">{item.state}</dt>
                        <dd className="text-right font-medium tabular-nums">
                          {item.count}
                        </dd>
                      </Fragment>
                    ))}
                  </dl>
                </CardContent>
              </Card>
            </div>
          ) : (
            <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4">
              <p className="text-sm text-destructive">
                {t("queueObservability.databaseUnavailable")}
              </p>
            </div>
          )}
        </div>

        {/* Operational Warning */}
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/50">
          <div className="flex gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="text-sm text-amber-800 dark:text-amber-200">
              <p className="font-medium">
                {t("queueObservability.disclaimerTitle")}
              </p>
              <p className="mt-1 text-amber-700/80 dark:text-amber-300/80">
                {t("queueObservability.disclaimerText")}
                <span className="font-semibold">
                  {t("queueObservability.disclaimerEmphasis")}
                </span>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
