/**
 * ERA 2 — Outbox recovery, stalled-job handling and lease safety.
 *
 * ## Outbox Recovery Model
 *
 * The Transactional Outbox guarantees that committed business intent survives
 * process crashes. Redis outage after PostgreSQL commit cannot destroy
 * committed intent.
 *
 * Recovery scenarios and guarantees:
 *
 * ### Redis unavailable after PostgreSQL commit
 *   - OutboxEvent row is committed in state PENDING or RETRYABLE.
 *   - Dispatcher can reach Redis but publication fails.
 *   - markOutboxPublicationFailed transitions to RETRYABLE with attemptCount++.
 *   - On Redis recovery, next dispatcher poll picks up the event.
 *   - Committed intent is NEVER lost.
 *
 * ### Publication succeeds but acknowledgment is lost (Redis crash before mark)
 *   - enqueueQueueJob succeeds; BullMQ has the job.
 *   - Dispatcher crashes before markOutboxPublished.
 *   - OutboxEvent is still CLAIMED; claimExpiresAt is set.
 *   - Next dispatcher poll with a different dispatcherId finds the expired CLAIMED
 *     event (claimOutboxEvents selects state CLAIMED WHERE claimExpiresAt <= now).
 *   - The new dispatcher re-publishes the job. BullMQ is idempotent by job ID
 *     (replaceExisting=true in enqueueQueueJob), so the job is not duplicated.
 *   - No committed intent is lost; no duplicate job is created.
 *
 * ### Dispatcher crashes mid-batch
 *   - Events may be left in CLAIMED state with an expired claimExpiresAt.
 *   - claimOutboxEvents picks these up on the next poll (expired CLAIMED is
 *     always eligible for re-claim).
 *   - BullMQ replaceExisting prevents duplicate job creation.
 *
 * ### Concurrent dispatchers
 *   - claimOutboxEvents uses FOR UPDATE SKIP LOCKED.
 *   - Only one dispatcher can claim a given event in any given poll cycle.
 *   - Concurrent dispatchers do not block each other.
 *
 * ### Poison events (terminal failures)
 *   - After maxAttempts, markOutboxPublicationFailed transitions to TERMINAL.
 *   - Terminal events are never re-claimed.
 *   - They remain inspectable in PostgreSQL for manual review.
 *   - Their failureCode and failureMessage are preserved.
 *
 * ## Stalled-Job Handling
 *
 * BullMQ has built-in stalled-job detection. By default, BullMQ marks a job
 * as stalled if a worker does not report progress within stallInterval (30s).
 *
 * Key safety invariant for this codebase:
 *   - BullMQ stalled-job recovery NEVER bypasses PostgreSQL ownership.
 *   - All job processing that calls Meta must re-validate PostgreSQL ownership
 *     before taking action that could have external effects.
 *   - Specifically, the outbound handler calls claimOutboundAttempt BEFORE
 *     making any Meta API call. The claim check ensures that even if a
 *     stalled-job recovery requeues a job, the second Meta call is rejected
 *     by PostgreSQL atomic ownership.
 *
 * ## OutboundLease Safety
 *
 * OutboundSendAttempt lease (60s) works as follows:
 *
 *   1. Worker calls claimOutboundAttempt → attempt becomes CLAIMED.
 *   2. Worker calls markOutboundMetaRequestStarted → metaRequestStartedAt set.
 *   3. Worker calls Meta API.
 *   4. Worker calls markOutboundSent / markOutboundUncertain / markOutboundFailed.
 *
 * Safety guarantees:
 *
 *   - If worker crashes AFTER metaRequestStartedAt is set but BEFORE step 4:
 *     the attempt stays CLAIMED. After lease expiry (60s), the attempt is
 *     eligible for re-claim ONLY if state IN ('PENDING', 'RETRYABLE').
 *     UNCERTAIN state is NOT in that list — UNCERTAIN never auto-retries.
 *
 *   - releaseExpiredClaim (used by recovery processes) can transition
 *     CLAIMED → RETRYABLE ONLY when claimExpiresAt < NOW() AND state is CLAIMED.
 *     It does NOT transition UNCERTAIN → RETRYABLE.
 *
 *   - If metaRequestStartedAt is set (Meta was called) and the attempt
 *     becomes RETRYABLE after lease expiry, a subsequent claim call to
 *     Meta is NOT authorized. The recovery operator must explicitly review
 *     and decide whether to retry — and the metaRequestStartedAt serves as
 *     evidence that Meta may have accepted the message.
 *
 * ## BullMQ Stalled-Job Recovery
 *
 * BullMQ's default stalled-job behavior:
 *   - If a job is not completed/failed within stallInterval (default 30s),
 *     BullMQ marks it as stalled and re-queues it.
 *   - This is safe because all workers re-validate PostgreSQL ownership.
 *   - The job ID is deterministic based on messageId, so BullMQ deduplicates
 *     via replaceExisting: true in enqueueQueueJob.
 *
 * We do NOT globally disable stalled-job recovery without evidence.
 * If global disabling is needed for a specific queue, it must be configured
 * explicitly and documented here.
 *
 * ## Operational Recovery Procedures
 *
 * ### Event is stuck in CLAIMED (dispatcher crashed)
 *   1. Check OutboxEvent.claimExpiresAt — if past, event is eligible for re-claim.
 *   2. Any dispatcher will pick it up on next poll.
 *   3. No manual action needed.
 *
 * ### Event is in TERMINAL state
 *   1. Inspect OutboxEvent.failureCode and OutboxEvent.failureMessage.
 *   2. Determine if the failure was infrastructure (retry may succeed) or permanent.
 *   3. To manually retry:
 *      - Reset OutboxEvent.state to RETRYABLE and attemptCount to 0.
 *      - OR create a new OutboxEvent with the same payload.
 *
 * ### Outbound message stuck in UNCERTAIN
 *   1. Inspect OutboundSendAttempt.metaRequestStartedAt.
 *      If set, Meta may have accepted the message — check WhatsApp Business
 *      Manager for delivery status before retrying.
 *   2. If confirmed not delivered: operator may manually create a new
 *      OutboundSendAttempt row and re-trigger via Outbox.
 *   3. NEVER auto-retry UNCERTAIN without operator review.
 *
 * ### Broadcast recipient stuck in PENDING
 *   1. Check BroadcastRecipient.error for UNCERTAIN or permanent failure.
 *   2. If UNCERTAIN: same guidance as outbound UNCERTAIN above.
 *   3. If permanent failure: inspect Broadcast.error.
 *   4. Cancelled campaigns stop eligible sends automatically; no retry needed.
 */

import { prisma } from "@/lib/prisma";
import { OUTBOX_STATES, type OutboxState } from "./contracts";

export { claimOutboxEvents } from "./repository";

export type OutboxPrisma = import("./repository").OutboxPrisma;

/**
 * Inspect all outbox states for operational monitoring.
 * Use this for health checks and manual recovery procedures.
 */
export async function inspectOutboxSummary(
  db: OutboxPrisma = prisma
): Promise<{
  pending: number;
  claimed: number;
  published: number;
  retryable: number;
  terminal: number;
  expiredLeases: number;
  oldestPendingAgeMs: number | null;
}> {
  const [pending, claimed, published, retryable, terminal, expiredLeases, oldestPending] =
    await Promise.all([
      db.outboxEvent.count({ where: { state: OUTBOX_STATES.PENDING } }),
      db.outboxEvent.count({ where: { state: OUTBOX_STATES.CLAIMED } }),
      db.outboxEvent.count({ where: { state: OUTBOX_STATES.PUBLISHED } }),
      db.outboxEvent.count({ where: { state: OUTBOX_STATES.RETRYABLE } }),
      db.outboxEvent.count({ where: { state: OUTBOX_STATES.TERMINAL } }),
      db.outboxEvent.count({
        where: {
          state: OUTBOX_STATES.CLAIMED,
          claimExpiresAt: { lt: new Date() },
        },
      }),
      db.outboxEvent.findFirst({
        where: {
          state: { in: [OUTBOX_STATES.PENDING, OUTBOX_STATES.RETRYABLE] },
        },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
    ]);

  return {
    pending,
    claimed,
    published,
    retryable,
    terminal,
    expiredLeases,
    oldestPendingAgeMs: oldestPending
      ? Date.now() - oldestPending.createdAt.getTime()
      : null,
  };
}

/**
 * Reset a terminal outbox event to RETRYABLE for manual retry.
 * Use only after operator review confirms the failure was transient.
 *
 * SAFETY: This does NOT automatically retry — it only makes the event
 * eligible for the next dispatcher poll. The dispatcher respects retryDelayMs.
 */
export async function resetTerminalOutboxEvent(
  db: OutboxPrisma,
  eventId: string
): Promise<{ success: boolean; state: OutboxState }> {
  const updated = await db.$executeRaw`
    UPDATE "OutboxEvent"
    SET
      "state" = 'RETRYABLE'::"OutboxPublicationState",
      "attemptCount" = 0,
      "claimedBy" = NULL,
      "claimExpiresAt" = NULL,
      "failureCode" = NULL,
      "failureMessage" = NULL,
      "updatedAt" = NOW()
    WHERE "id" = ${eventId}
      AND "state" = 'TERMINAL'::"OutboxPublicationState"
  `;
  const row = await db.$queryRaw<{ state: OutboxState }[]>`
    SELECT "state" FROM "OutboxEvent" WHERE "id" = ${eventId}
  `;
  return {
    success: updated === 1,
    state: row[0]?.state ?? OUTBOX_STATES.TERMINAL,
  };
}

/**
 * Release an expired OutboundSendAttempt claim (used for recovery of
 * crashed workers where metaRequestStartedAt was NOT set).
 *
 * SAFETY constraints:
 *   - ONLY releases CLAIMED attempts where claimExpiresAt < NOW().
 *   - Does NOT release UNCERTAIN attempts (AMBIGUOUS_EXTERNAL protection).
 *   - Does NOT release attempts where metaRequestStartedAt is set
 *     (Meta may have received the request).
 *
 * @returns The released attempt record, or null if not eligible for release.
 */
export async function releaseExpiredOutboundClaim(
  db: OutboxPrisma,
  attemptId: string
): Promise<{
  released: boolean;
  reason?: string;
}> {
  // Check metaRequestStartedAt before releasing
  const before = await db.$queryRaw<{ state: string; metaRequestStartedAt: Date | null }[]>`
    SELECT "state", "metaRequestStartedAt"
    FROM "OutboundSendAttempt"
    WHERE "id" = ${attemptId}
  `;

  if (!before[0]) return { released: false, reason: "NOT_FOUND" };

  // Never release UNCERTAIN
  if (before[0].state === "UNCERTAIN") {
    return { released: false, reason: "UNCERTAIN_STATE" };
  }

  // If metaRequestStartedAt is set, Meta may have accepted the request
  if (before[0].metaRequestStartedAt) {
    return { released: false, reason: "META_REQUEST_STARTED" };
  }

  const { releaseExpiredClaim } = await import("@/lib/whatsapp/outbound/repository");
  const released = await releaseExpiredClaim(db, attemptId);
  return {
    released: released !== null,
    reason: released ? "OK" : "NOT_ELIGIBLE",
  };
}
