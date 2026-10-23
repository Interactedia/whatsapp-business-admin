import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { OutboundAttemptState } from "@/generated/prisma/client";

export interface OutboundAttemptRecord {
  id: string;
  messageId: string;
  tenantId: string;
  state: OutboundAttemptState;
  attemptCount: number;
  autoRetryCount: number;
  nextEligibleRetryAt: Date | null;
  lastRetryAfterSec: number | null;
  ownerId: string | null;
  claimExpiresAt: Date | null;
  metaRequestStartedAt: Date | null;
  waMessageId: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastMetaStatus: number | null;
  createdAt: Date;
  updatedAt: Date;
  claimedAt: Date | null;
  finishedAt: Date | null;
}

export type OutboundPrisma = Prisma.TransactionClient | typeof prisma;

const DEFAULT_LEASE_MS = 60_000;

export interface ClaimOutboundAttemptInput {
  messageId: string;
  tenantId: string;
  ownerId: string;
  leaseMs?: number;
  now?: Date;
}

export interface ClaimOutboundAttemptResult {
  claimed: boolean;
  attempt: OutboundAttemptRecord | null;
  existingState: OutboundAttemptState | null;
}

export interface MarkOutboundMetaRequestStartedInput {
  attemptId: string;
  ownerId: string;
  now?: Date;
}

export interface MarkOutboundSentInput {
  attemptId: string;
  waMessageId: string;
}

export interface MarkOutboundFailedInput {
  attemptId: string;
  errorCode: string;
  errorMessage: string;
  retryable: boolean;
  metaStatus?: number;
}

export interface MarkOutboundUncertainInput {
  attemptId: string;
  errorCode: string;
  errorMessage: string;
  metaStatus?: number;
}

export async function getOrCreateOutboundAttempt(
  tx: OutboundPrisma,
  input: { messageId: string; tenantId: string }
): Promise<OutboundAttemptRecord> {
  const existing = await tx.outboundSendAttempt.findFirst({
    where: { messageId: input.messageId },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return existing as OutboundAttemptRecord;

  const id = randomUUID();
  const [row] = await tx.$queryRaw<OutboundAttemptRecord[]>`
    INSERT INTO "OutboundSendAttempt" ("id", "messageId", "tenantId", "state", "attemptCount", "createdAt", "updatedAt")
    VALUES (${id}, ${input.messageId}, ${input.tenantId}, 'PENDING'::"OutboundAttemptState", 0, NOW(), NOW())
    RETURNING *
  `;
  return row;
}

export async function claimOutboundAttempt(
  db: OutboundPrisma,
  input: ClaimOutboundAttemptInput
): Promise<ClaimOutboundAttemptResult> {
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  const newExpiry = new Date(now.getTime() + leaseMs);

  const [row] = await db.$queryRaw<OutboundAttemptRecord[]>`
    UPDATE "OutboundSendAttempt"
    SET "state" = 'CLAIMED'::"OutboundAttemptState",
        "ownerId" = ${input.ownerId},
        "claimExpiresAt" = ${newExpiry},
        "claimedAt" = COALESCE("claimedAt", ${now}),
        "attemptCount" = "attemptCount" + 1,
        "updatedAt" = NOW()
    WHERE "messageId" = ${input.messageId}
      AND "tenantId" = ${input.tenantId}
      AND "state" IN ('PENDING'::"OutboundAttemptState", 'RETRYABLE'::"OutboundAttemptState")
    RETURNING *
  `;
  if (row) {
    return { claimed: true, attempt: row, existingState: row.state };
  }
  const current = await db.outboundSendAttempt.findFirst({
    where: { messageId: input.messageId, tenantId: input.tenantId },
    orderBy: { createdAt: "desc" },
  });
  return {
    claimed: false,
    attempt: (current as OutboundAttemptRecord | null) ?? null,
    existingState: current?.state ?? null,
  };
}

export async function markOutboundMetaRequestStarted(
  db: OutboundPrisma,
  input: MarkOutboundMetaRequestStartedInput
): Promise<OutboundAttemptRecord | null> {
  const now = input.now ?? new Date();
  const [row] = await db.$queryRaw<OutboundAttemptRecord[]>`
    UPDATE "OutboundSendAttempt"
    SET "metaRequestStartedAt" = COALESCE("metaRequestStartedAt", ${now}),
        "updatedAt" = NOW()
    WHERE "id" = ${input.attemptId}
      AND "ownerId" = ${input.ownerId}
      AND "state" = 'CLAIMED'::"OutboundAttemptState"
    RETURNING *
  `;
  return row ?? null;
}

export async function markOutboundSent(
  db: OutboundPrisma,
  input: MarkOutboundSentInput
): Promise<OutboundAttemptRecord> {
  const [row] = await db.$queryRaw<OutboundAttemptRecord[]>`
    UPDATE "OutboundSendAttempt"
    SET "state" = 'SENT'::"OutboundAttemptState",
        "waMessageId" = ${input.waMessageId},
        "claimExpiresAt" = NULL,
        "metaRequestStartedAt" = NULL,
        "lastErrorCode" = NULL,
        "lastErrorMessage" = NULL,
        "finishedAt" = NOW(),
        "updatedAt" = NOW()
    WHERE "id" = ${input.attemptId}
      AND "state" = 'CLAIMED'::"OutboundAttemptState"
    RETURNING *
  `;
  if (!row) {
    throw new Error(`Cannot mark attempt ${input.attemptId} as SENT — not in CLAIMED state`);
  }
  return row;
}

export async function markOutboundFailed(
  db: OutboundPrisma,
  input: MarkOutboundFailedInput
): Promise<OutboundAttemptRecord> {
  const targetState: OutboundAttemptState = input.retryable ? "RETRYABLE" : "FAILED";
  const [row] = await db.$queryRaw<OutboundAttemptRecord[]>`
    UPDATE "OutboundSendAttempt"
    SET "state" = ${targetState}::"OutboundAttemptState",
        "claimExpiresAt" = NULL,
        "metaRequestStartedAt" = NULL,
        "lastErrorCode" = ${input.errorCode},
        "lastErrorMessage" = ${input.errorMessage},
        "lastMetaStatus" = ${input.metaStatus ?? null},
        "updatedAt" = NOW()
    WHERE "id" = ${input.attemptId}
      AND "state" = 'CLAIMED'::"OutboundAttemptState"
    RETURNING *
  `;
  if (!row) {
    throw new Error(`Cannot mark attempt ${input.attemptId} as ${targetState} — not in CLAIMED state`);
  }
  return row;
}

export async function markOutboundUncertain(
  db: OutboundPrisma,
  input: MarkOutboundUncertainInput
): Promise<OutboundAttemptRecord> {
  const [row] = await db.$queryRaw<OutboundAttemptRecord[]>`
    UPDATE "OutboundSendAttempt"
    SET "state" = 'UNCERTAIN'::"OutboundAttemptState",
        "claimExpiresAt" = NULL,
        "metaRequestStartedAt" = NULL,
        "lastErrorCode" = ${input.errorCode},
        "lastErrorMessage" = ${input.errorMessage},
        "lastMetaStatus" = ${input.metaStatus ?? null},
        "finishedAt" = NOW(),
        "updatedAt" = NOW()
    WHERE "id" = ${input.attemptId}
      AND "state" = 'CLAIMED'::"OutboundAttemptState"
    RETURNING *
  `;
  if (!row) {
    throw new Error(`Cannot mark attempt ${input.attemptId} as UNCERTAIN — not in CLAIMED state`);
  }
  return row;
}

export async function releaseExpiredClaim(
  db: OutboundPrisma,
  attemptId: string
): Promise<OutboundAttemptRecord | null> {
  const [row] = await db.$queryRaw<OutboundAttemptRecord[]>`
    UPDATE "OutboundSendAttempt"
    SET "state" = 'RETRYABLE'::"OutboundAttemptState",
        "claimExpiresAt" = NULL,
        "ownerId" = NULL,
        "updatedAt" = NOW()
    WHERE "id" = ${attemptId}
      AND "state" = 'CLAIMED'::"OutboundAttemptState"
      AND "claimExpiresAt" < NOW()
      AND "metaRequestStartedAt" IS NULL
    RETURNING *
  `;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// WA-OUTRETRY-01 — Auto-retry helpers
// ---------------------------------------------------------------------------

export interface MarkOutboundAutoRetryScheduledInput {
  attemptId: string;
  /** Wall-clock time at which the scheduler may re-enqueue. */
  nextEligibleRetryAt: Date;
  /** Parsed Retry-After from Meta in seconds, when present. */
  retryAfterSeconds: number | null;
  /** Incremented from the previous value atomically. */
  autoRetryCount: number;
}

/**
 * Mark a RETRYABLE attempt as eligible for the auto-retry scheduler.
 *
 * The state stays RETRYABLE; the scheduler queries by
 * `state=RETRYABLE AND nextEligibleRetryAt <= now()`. The same UPDATE
 * also sets `lastRetryAfterSec` and `autoRetryCount` so evidence survives
 * across scheduler restarts.
 */
export async function markOutboundAutoRetryScheduled(
  db: OutboundPrisma,
  input: MarkOutboundAutoRetryScheduledInput
): Promise<OutboundAttemptRecord> {
  const [row] = await db.$queryRaw<OutboundAttemptRecord[]>`
    UPDATE "OutboundSendAttempt"
    SET "nextEligibleRetryAt" = ${input.nextEligibleRetryAt},
        "lastRetryAfterSec" = ${input.retryAfterSeconds},
        "autoRetryCount" = ${input.autoRetryCount},
        "updatedAt" = NOW()
    WHERE "id" = ${input.attemptId}
      AND "state" = 'RETRYABLE'::"OutboundAttemptState"
    RETURNING *
  `;
  if (!row) {
    throw new Error(
      `Cannot mark attempt ${input.attemptId} as auto-retry-scheduled — not in RETRYABLE state`,
    );
  }
  return row;
}

export interface AutoRetryCandidate {
  attemptId: string;
  messageId: string;
  tenantId: string;
  wabaAccountId: string | null;
  phoneNumberId: string | null;
  conversationId: string | null;
  autoRetryCount: number;
  lastRetryAfterSec: number | null;
  nextEligibleRetryAt: Date;
}

/**
 * Atomically claim a batch of auto-retry candidates for re-enqueueing.
 *
 * The state is **not** flipped to PENDING here. The row stays in
 * `RETRYABLE` and the scheduler re-enqueues with the existing BullMQ
 * `jobId` (deterministic from messageId). If the scheduler crashes after
 * this query but before `enqueueQueueJob` returns, the row is still
 * RETRYABLE with a past `nextEligibleRetryAt`; the next tick re-picks
 * it. If `enqueueQueueJob` succeeds, the worker will see the row in
 * RETRYABLE and `claimOutboundAttempt` will move it to CLAIMED. If the
 * job is already in BullMQ, the deterministic jobId prevents
 * duplication.
 *
 * `FOR UPDATE SKIP LOCKED` ensures two concurrent scheduler instances
 * never enqueue the same message twice in a single tick.
 */
export async function claimAutoRetryCandidates(
  db: OutboundPrisma,
  input: { now?: Date; limit: number }
): Promise<AutoRetryCandidate[]> {
  const now = input.now ?? new Date();
  const rows = await db.$queryRaw<Array<{
    id: string;
    messageId: string;
    tenantId: string;
    autoRetryCount: number;
    lastRetryAfterSec: number | null;
    nextEligibleRetryAt: Date;
    wabaAccountId: string | null;
    phoneNumberId: string | null;
    conversationId: string | null;
  }>>`
    SELECT a."id"            AS "id",
           a."messageId"     AS "messageId",
           a."tenantId"      AS "tenantId",
           a."autoRetryCount" AS "autoRetryCount",
           a."lastRetryAfterSec" AS "lastRetryAfterSec",
           a."nextEligibleRetryAt" AS "nextEligibleRetryAt",
           m."conversationId" AS "conversationId",
           (
             SELECT pn."wabaAccountId"
             FROM "Conversation" c
             JOIN "PhoneNumber" pn ON pn."id" = c."phoneNumberId"
             WHERE c."id" = m."conversationId"
           ) AS "wabaAccountId",
           (
             SELECT pn."id"
             FROM "Conversation" c
             JOIN "PhoneNumber" pn ON pn."id" = c."phoneNumberId"
             WHERE c."id" = m."conversationId"
           ) AS "phoneNumberId"
    FROM "OutboundSendAttempt" a, "Message" m
    WHERE a."state" = 'RETRYABLE'::"OutboundAttemptState"
      AND a."nextEligibleRetryAt" IS NOT NULL
      AND a."nextEligibleRetryAt" <= ${now}
      AND m."id" = a."messageId"
    ORDER BY a."nextEligibleRetryAt" ASC
    LIMIT ${input.limit}
    FOR UPDATE SKIP LOCKED
  `;
  return rows.map((r) => ({
    attemptId: r.id,
    messageId: r.messageId,
    tenantId: r.tenantId,
    wabaAccountId: r.wabaAccountId,
    phoneNumberId: r.phoneNumberId,
    conversationId: r.conversationId,
    autoRetryCount: r.autoRetryCount,
    lastRetryAfterSec: r.lastRetryAfterSec,
    nextEligibleRetryAt: r.nextEligibleRetryAt,
  }));
}

/**
 * Push `nextEligibleRetryAt` out for a row that the scheduler is about
 * to enqueue. The state stays RETRYABLE so the next tick (or a crashed
 * one) does not double-enqueue. BullMQ's deterministic jobId keeps the
 * external side deduplicated.
 */
export async function markAutoRetryEnqueueAttempted(
  db: OutboundPrisma,
  input: { attemptId: string; holdUntil: Date; now?: Date }
): Promise<OutboundAttemptRecord | null> {
  const [row] = await db.$queryRaw<OutboundAttemptRecord[]>`
    UPDATE "OutboundSendAttempt"
    SET "nextEligibleRetryAt" = ${input.holdUntil},
        "updatedAt" = NOW()
    WHERE "id" = ${input.attemptId}
      AND "state" = 'RETRYABLE'::"OutboundAttemptState"
    RETURNING *
  `;
  return row ?? null;
}

/**
 * Roll back a scheduler claim when the BullMQ enqueue fails. The row
 * stays RETRYABLE and `nextEligibleRetryAt` is pushed out by a short
 * backoff so the same scheduler tick does not immediately re-pick it.
 */
export async function releaseAutoRetryClaim(
  db: OutboundPrisma,
  input: { attemptId: string; backoffSeconds: number; now?: Date }
): Promise<OutboundAttemptRecord | null> {
  const now = input.now ?? new Date();
  const nextAt = new Date(now.getTime() + input.backoffSeconds * 1000);
  const [row] = await db.$queryRaw<OutboundAttemptRecord[]>`
    UPDATE "OutboundSendAttempt"
    SET "state" = 'RETRYABLE'::"OutboundAttemptState",
        "nextEligibleRetryAt" = ${nextAt},
        "updatedAt" = NOW()
    WHERE "id" = ${input.attemptId}
      AND "state" IN ('RETRYABLE'::"OutboundAttemptState", 'PENDING'::"OutboundAttemptState")
    RETURNING *
  `;
  return row ?? null;
}

/**
 * Recover stuck CLAIMED rows whose lease has expired.
 *
 * - Pre-frontier crash (metaRequestStartedAt IS NULL) → RETRYABLE with
 *   `nextEligibleRetryAt` pushed out by the smallest ladder step so
 *   the auto-retry scheduler re-enqueues it. The autoRetryCount is
 *   *not* incremented: this is recovery from a crash, not a real
 *   failed send. The next time the worker actually calls Meta and
 *   fails, the counter advances normally.
 * - Post-frontier crash (metaRequestStartedAt IS NOT NULL) → UNCERTAIN
 *   because Meta may have accepted. NEVER auto-retried.
 */
export async function recoverExpiredLeases(
  db: OutboundPrisma,
  input: { now?: Date; limit?: number; preFrontierHoldSeconds?: number }
): Promise<{ preFrontier: number; postFrontier: number }> {
  const now = input.now ?? new Date();
  const limit = input.limit ?? 100;
  const holdSeconds = input.preFrontierHoldSeconds ?? 30;
  const holdUntil = new Date(now.getTime() + holdSeconds * 1000);

  const pre = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE "OutboundSendAttempt"
    SET "state" = 'RETRYABLE'::"OutboundAttemptState",
        "claimExpiresAt" = NULL,
        "ownerId" = NULL,
        "nextEligibleRetryAt" = ${holdUntil},
        "lastErrorCode" = COALESCE("lastErrorCode", 'LEASE_EXPIRED_PRE_FRONTIER'),
        "updatedAt" = NOW()
    WHERE "id" IN (
      SELECT "id" FROM "OutboundSendAttempt"
      WHERE "state" = 'CLAIMED'::"OutboundAttemptState"
        AND "claimExpiresAt" < ${now}
        AND "metaRequestStartedAt" IS NULL
      ORDER BY "claimExpiresAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id"
  `;

  const post = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE "OutboundSendAttempt"
    SET "state" = 'UNCERTAIN'::"OutboundAttemptState",
        "claimExpiresAt" = NULL,
        "ownerId" = NULL,
        "lastErrorCode" = COALESCE("lastErrorCode", 'LEASE_EXPIRED_POST_FRONTIER'),
        "finishedAt" = NOW(),
        "updatedAt" = NOW()
    WHERE "id" IN (
      SELECT "id" FROM "OutboundSendAttempt"
      WHERE "state" = 'CLAIMED'::"OutboundAttemptState"
        AND "claimExpiresAt" < ${now}
        AND "metaRequestStartedAt" IS NOT NULL
      ORDER BY "claimExpiresAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id"
  `;

  return { preFrontier: pre.length, postFrontier: post.length };
}
