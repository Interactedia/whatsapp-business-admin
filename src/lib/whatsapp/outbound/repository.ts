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
