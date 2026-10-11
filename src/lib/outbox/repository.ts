import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import {
  OUTBOX_CONTRACT_VERSION,
  OUTBOX_DEFAULT_BATCH_SIZE,
  OUTBOX_DEFAULT_LEASE_MS,
  OUTBOX_DEFAULT_MAX_ATTEMPTS,
  OUTBOX_DEFAULT_RETRY_DELAY_MS,
  OUTBOX_STATES,
  OutboxError,
  type ClaimOutboxEventsOptions,
  type OutboxEventInput,
  type OutboxEventRecord,
  sanitizeFailure,
  validateOutboxEventInput,
} from "./contracts";

export type OutboxPrisma = Prisma.TransactionClient | typeof prisma;

type RawOutboxRow = Omit<OutboxEventRecord, "payload"> & { payload: unknown };

const rowToRecord = (row: RawOutboxRow): OutboxEventRecord => ({
  ...row,
  payload: validateOutboxEventInput({ tenantId: row.tenantId, payload: row.payload as never }),
});

export async function insertOutboxEvent(
  tx: OutboxPrisma,
  input: OutboxEventInput
): Promise<OutboxEventRecord> {
  const payload = validateOutboxEventInput(input);
  const [row] = await tx.$queryRaw<RawOutboxRow[]>`
    INSERT INTO "OutboxEvent" (
      "id", "tenantId", "eventType", "contractVersion", "payload", "maxAttempts", "nextAttemptAt", "updatedAt"
    ) VALUES (
      ${randomUUID()},
      ${input.tenantId},
      ${payload.type},
      ${OUTBOX_CONTRACT_VERSION},
      ${payload as unknown as Prisma.InputJsonValue},
      ${input.maxAttempts ?? OUTBOX_DEFAULT_MAX_ATTEMPTS},
      ${input.nextAttemptAt ?? new Date()},
      ${new Date()}
    ) RETURNING *
  `;
  return rowToRecord(row);
}

export async function claimOutboxEvents(
  db: OutboxPrisma,
  options: ClaimOutboxEventsOptions
): Promise<OutboxEventRecord[]> {
  const now = options.now ?? new Date();
  const batchSize = Math.max(1, Math.min(options.batchSize ?? OUTBOX_DEFAULT_BATCH_SIZE, 100));
  const claimExpiresAt = new Date(now.getTime() + (options.leaseMs ?? OUTBOX_DEFAULT_LEASE_MS));

  const rows = await db.$queryRaw<RawOutboxRow[]>`
    WITH available AS (
      SELECT "id"
      FROM "OutboxEvent"
      WHERE
        (
          "state" IN ('PENDING'::"OutboxPublicationState", 'RETRYABLE'::"OutboxPublicationState")
          AND "nextAttemptAt" <= ${now}
        )
        OR (
          "state" = 'CLAIMED'::"OutboxPublicationState"
          AND "claimExpiresAt" <= ${now}
        )
      ORDER BY "nextAttemptAt" ASC, "createdAt" ASC, "id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    )
    UPDATE "OutboxEvent" outbox
    SET
      "state" = 'CLAIMED'::"OutboxPublicationState",
      "claimedBy" = ${options.dispatcherId},
      "claimExpiresAt" = ${claimExpiresAt},
      "lastAttemptedAt" = ${now},
      "updatedAt" = ${now}
    FROM available
    WHERE outbox."id" = available."id"
    RETURNING outbox.*
  `;

  return rows.map(rowToRecord);
}

export async function markOutboxPublished(
  db: OutboxPrisma,
  eventId: string,
  dispatcherId: string,
  now = new Date()
): Promise<boolean> {
  const updated = await db.$executeRaw`
    UPDATE "OutboxEvent"
    SET
      "state" = 'PUBLISHED'::"OutboxPublicationState",
      "publishedAt" = ${now},
      "claimedBy" = NULL,
      "claimExpiresAt" = NULL,
      "failureCode" = NULL,
      "failureMessage" = NULL,
      "updatedAt" = ${now}
    WHERE "id" = ${eventId}
      AND "state" = 'CLAIMED'::"OutboxPublicationState"
      AND "claimedBy" = ${dispatcherId}
  `;
  return updated === 1;
}

export async function markOutboxPublicationFailed(
  db: OutboxPrisma,
  event: Pick<OutboxEventRecord, "id" | "attemptCount" | "maxAttempts">,
  dispatcherId: string,
  error: unknown,
  options: { retryDelayMs?: number; now?: Date } = {}
): Promise<"RETRYABLE" | "TERMINAL"> {
  const now = options.now ?? new Date();
  const attemptCount = event.attemptCount + 1;
  const terminal = attemptCount >= event.maxAttempts;
  const state = terminal ? OUTBOX_STATES.TERMINAL : OUTBOX_STATES.RETRYABLE;
  const failure = sanitizeFailure(error);
  const nextAttemptAt = new Date(now.getTime() + (options.retryDelayMs ?? OUTBOX_DEFAULT_RETRY_DELAY_MS));

  const updated = await db.$executeRaw`
    UPDATE "OutboxEvent"
    SET
      "state" = ${state}::"OutboxPublicationState",
      "attemptCount" = ${attemptCount},
      "nextAttemptAt" = ${nextAttemptAt},
      "claimedBy" = NULL,
      "claimExpiresAt" = NULL,
      "failureCode" = ${failure.code},
      "failureMessage" = ${failure.message},
      "updatedAt" = ${now}
    WHERE "id" = ${event.id}
      AND "state" = 'CLAIMED'::"OutboxPublicationState"
      AND "claimedBy" = ${dispatcherId}
  `;
  if (updated !== 1) throw new OutboxError("CLAIM_OWNERSHIP", "Outbox claim ownership check failed");
  return state;
}

export async function getOutboxEvent(db: OutboxPrisma, eventId: string): Promise<OutboxEventRecord | null> {
  const rows = await db.$queryRaw<RawOutboxRow[]>`SELECT * FROM "OutboxEvent" WHERE "id" = ${eventId}`;
  return rows[0] ? rowToRecord(rows[0]) : null;
}
