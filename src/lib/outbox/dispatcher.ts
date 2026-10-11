import { enqueueQueueJob, QueueProducerError } from "@/lib/queue";
import { prisma } from "@/lib/prisma";
import type { OutboxDispatchOptions, OutboxDispatchResult } from "./contracts";
import {
  claimOutboxEvents,
  markOutboxPublicationFailed,
  markOutboxPublished,
  type OutboxPrisma,
} from "./repository";

export async function dispatchOutboxBatch(
  options: OutboxDispatchOptions,
  db: OutboxPrisma = prisma
): Promise<OutboxDispatchResult> {
  const events = await claimOutboxEvents(db, options);
  const result: OutboxDispatchResult = { claimed: events.length, published: 0, failed: 0, terminal: 0 };

  for (const event of events) {
    try {
      await enqueueQueueJob(event.payload, { queue: options.queue, closeQueueAfterEnqueue: !options.queue });
      const acknowledged = await markOutboxPublished(db, event.id, options.dispatcherId);
      if (acknowledged) result.published += 1;
      else result.failed += 1;
    } catch (error) {
      const state = await markOutboxPublicationFailed(db, event, options.dispatcherId, error, {
        retryDelayMs: options.retryDelayMs,
      });
      if (state === "TERMINAL") result.terminal += 1;
      else result.failed += 1;

      if (!(error instanceof QueueProducerError)) {
        console.error("outbox publication failed", { eventId: event.id, tenantId: event.tenantId, state });
      }
    }
  }

  return result;
}

export class OutboxDispatcher {
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly options: OutboxDispatchOptions & { pollMs?: number },
    private readonly db: OutboxPrisma = prisma
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      await dispatchOutboxBatch(this.options, this.db);
    } finally {
      if (!this.stopped) {
        this.timer = setTimeout(() => void this.tick(), Math.max(250, this.options.pollMs ?? 5_000));
      }
    }
  }
}
