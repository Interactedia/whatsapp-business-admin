#!/usr/bin/env tsx
/**
 * WA-OUTRETRY-01 — Outbound auto-retry scheduler.
 *
 * Polls the OutboundSendAttempt table for RETRYABLE rows whose
 * `nextEligibleRetryAt <= now()` and re-enqueues them into the same
 * outbound-messages BullMQ queue used by the regular send path.
 *
 * Concurrency is enforced at the database level by `FOR UPDATE SKIP LOCKED`
 * inside `claimAutoRetryCandidates`. Two scheduler instances may run
 * concurrently without producing duplicate enqueues.
 *
 * The scheduler does NOT bypass the handler — it simply re-enqueues the
 * existing payload; `handleOutboundMessage` then claims the attempt the
 * same way it does for the original send.
 *
 * Run as a separate process (matches the existing scripts/* pattern).
 */
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { closeAllQueueResources, enqueueQueueJob } from "@/lib/queue";
import {
  claimAutoRetryCandidates,
  releaseAutoRetryClaim,
  markAutoRetryEnqueueAttempted,
  recoverExpiredLeases,
  type AutoRetryCandidate,
} from "@/lib/whatsapp/outbound/repository";
import {
  AUTO_RETRY_SCHEDULER_BATCH,
  AUTO_RETRY_SCHEDULER_DISPATCHER_ID,
  AUTO_RETRY_SCHEDULER_POLL_MS,
} from "@/lib/whatsapp/outbound/retry-config";
import { createOutboundMessageJobPayload } from "@/lib/queue/jobs/outbound";

class OutboundRetryScheduler {
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly options: {
      pollMs: number;
      batchSize: number;
      dispatcherId: string;
    },
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

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), this.options.pollMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.runOnce();
    } catch (err) {
      console.error("[outbound-retry-scheduler] tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.scheduleNext();
    }
  }

  /**
   * Exposed for tests: run a single pass and return counts.
   */
  async runOnce(now: Date = new Date()): Promise<{
    recovered: { preFrontier: number; postFrontier: number };
    claimed: number;
    enqueued: number;
    rolledBack: number;
  }> {
    const recovered = await recoverExpiredLeases(prisma, { now, limit: 100 });
    const candidates = await claimAutoRetryCandidates(prisma, {
      now,
      limit: this.options.batchSize,
    });

    let enqueued = 0;
    let rolledBack = 0;

    for (const c of candidates) {
      const ok = await this.enqueueCandidate(c);
      if (ok) enqueued += 1;
      else rolledBack += 1;
    }

    if (recovered.preFrontier + recovered.postFrontier + candidates.length > 0) {
      console.log("[outbound-retry-scheduler] tick", {
        dispatcherId: this.options.dispatcherId,
        recovered,
        claimed: candidates.length,
        enqueued,
        rolledBack,
      });
    }
    return { recovered, claimed: candidates.length, enqueued, rolledBack };
  }

  private async enqueueCandidate(c: AutoRetryCandidate): Promise<boolean> {
    if (!c.wabaAccountId || !c.phoneNumberId || !c.conversationId) {
      // Missing reference data — push the row back so an operator sees it.
      await releaseAutoRetryClaim(prisma, {
        attemptId: c.attemptId,
        backoffSeconds: 60,
      });
      console.warn("[outbound-retry-scheduler] candidate missing reference", { candidate: c });
      return false;
    }
    // Push nextEligibleRetryAt forward by the polling window so the
    // next tick does not re-pick the same row while the enqueue is in
    // flight. If the scheduler crashes here, the next tick re-picks it
    // because the hold has elapsed; BullMQ's deterministic jobId keeps
    // the external side deduplicated.
    const holdUntil = new Date(Date.now() + this.options.pollMs);
    await markAutoRetryEnqueueAttempted(prisma, { attemptId: c.attemptId, holdUntil });
    try {
      const payload = createOutboundMessageJobPayload({
        tenantId: c.tenantId,
        wabaAccountId: c.wabaAccountId,
        phoneNumberId: c.phoneNumberId,
        conversationId: c.conversationId,
        messageId: c.messageId,
        producer: `manual:${this.options.dispatcherId}`,
      });
      await enqueueQueueJob(payload, {
        closeQueueAfterEnqueue: true,
        jobOptions: { jobId: `${c.messageId}-retry-${c.autoRetryCount}` },
      });
      return true;
    } catch (err) {
      await releaseAutoRetryClaim(prisma, {
        attemptId: c.attemptId,
        backoffSeconds: 30,
      });
      console.error("[outbound-retry-scheduler] enqueue failed", {
        attemptId: c.attemptId,
        messageId: c.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}

const scheduler = new OutboundRetryScheduler({
  pollMs: AUTO_RETRY_SCHEDULER_POLL_MS,
  batchSize: AUTO_RETRY_SCHEDULER_BATCH,
  dispatcherId: AUTO_RETRY_SCHEDULER_DISPATCHER_ID,
});

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[outbound-retry-scheduler] ${signal} received, stopping`);
  await scheduler.stop();
  await closeAllQueueResources();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

await prisma.$queryRaw`SELECT 1`;
scheduler.start();
console.log("[outbound-retry-scheduler] ready", {
  pollMs: AUTO_RETRY_SCHEDULER_POLL_MS,
  batchSize: AUTO_RETRY_SCHEDULER_BATCH,
  dispatcherId: AUTO_RETRY_SCHEDULER_DISPATCHER_ID,
});

export { OutboundRetryScheduler };
