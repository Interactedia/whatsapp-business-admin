import { Fragment } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { collectOutboxObservability } from "@/lib/outbox/observability";
import { collectQueueObservability } from "@/lib/queue/observability";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default async function QueueObservabilityPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "SYSTEM_ADMIN") redirect("/");

  const [queues, database] = await Promise.all([
    collectQueueObservability(),
    collectOutboxObservability(),
  ]);

  const outbox = database.available ? database.outbox : null;
  const attempts = database.available ? database.outboundAttempts : [];
  const uncertain = attempts.find((item) => item.state === "UNCERTAIN")?.count ?? 0;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Queue & Outbox Observability"
        description="Read-only operational signals for BullMQ queues, outbox publication, and outbound send outcomes."
      />

      <div className="flex-1 space-y-4 overflow-auto p-4">
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader><CardTitle>Queue metrics</CardTitle></CardHeader>
            <CardContent><Badge variant={queues.available ? "success" : "warning"}>{queues.available ? "available" : "unavailable"}</Badge></CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Outbox terminal</CardTitle></CardHeader>
            <CardContent className="text-2xl font-semibold">{outbox ? outbox.terminal : "unavailable"}</CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>UNCERTAIN attempts</CardTitle></CardHeader>
            <CardContent className="text-2xl font-semibold">{database.available ? uncertain : "unavailable"}</CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader><CardTitle>BullMQ queues</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Queue</TableHead><TableHead>Waiting</TableHead><TableHead>Active</TableHead><TableHead>Delayed</TableHead><TableHead>Completed</TableHead><TableHead>Failed</TableHead><TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queues.queues.map((queue) => (
                  <TableRow key={queue.name}>
                    <TableCell>{queue.name}</TableCell>
                    {queue.available ? (
                      <>
                        <TableCell>{queue.result.counts.waiting}</TableCell><TableCell>{queue.result.counts.active}</TableCell><TableCell>{queue.result.counts.delayed}</TableCell><TableCell>{queue.result.counts.completed}</TableCell><TableCell>{queue.result.counts.failed}</TableCell><TableCell>{queue.result.isPaused ? "paused" : "running"}</TableCell>
                      </>
                    ) : (
                      <TableCell colSpan={6}>unavailable ({queue.error})</TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>PostgreSQL outbox and Meta send outcomes</CardTitle></CardHeader>
          <CardContent>
            {database.available && outbox ? (
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-sm font-medium">Outbox publication state</h3>
                  <dl className="grid grid-cols-2 gap-2 text-sm">
                    <dt>Pending</dt><dd>{outbox.pending}</dd><dt>Claimed</dt><dd>{outbox.claimed}</dd><dt>Retryable</dt><dd>{outbox.retryable}</dd><dt>Published</dt><dd>{outbox.published}</dd><dt>Terminal</dt><dd>{outbox.terminal}</dd><dt>Expired leases</dt><dd>{outbox.expiredLeases}</dd>
                  </dl>
                </div>
                <div>
                  <h3 className="mb-2 text-sm font-medium">Outbound send attempt state</h3>
                  <dl className="grid grid-cols-2 gap-2 text-sm">
                    {attempts.map((item) => <Fragment key={item.state}><dt>{item.state}</dt><dd>{item.count}</dd></Fragment>)}
                  </dl>
                </div>
              </div>
            ) : !database.available ? (
              <p>database metrics unavailable ({database.error})</p>
            ) : null}
          </CardContent>
        </Card>

        <p className="text-sm text-muted-foreground">
          BullMQ completion and outbox publication are not Meta delivery evidence. UNCERTAIN means the external Meta outcome is unknown and must not be treated as FAILED or automatically retryable.
        </p>
      </div>
    </div>
  );
}
