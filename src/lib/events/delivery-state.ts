import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import type { CanonicalEventPrisma } from "@/lib/events/outbox";

export const DELIVERY_STATES = ["PENDING", "IN_PROGRESS", "RETRY_PENDING", "ACCEPTED", "FAILED_TERMINAL", "SUSPENDED"] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];
export type DeliveryAttemptResult = "ACCEPTED" | "RETRYABLE" | "TERMINAL" | "INTERRUPTED";

export const DEFAULT_DELIVERY_LEASE_MS = 45_000;
export const MAX_DELIVERY_ERROR_SUMMARY_LENGTH = 500;

export interface DeliveryIdentity {
  tenantId: string;
  eventId: string;
  destinationId: string;
}

export interface EnsureDeliveryOptions extends DeliveryIdentity {
  maxAttempts?: number;
  nextAttemptAt?: Date;
}

export interface DeliveryRecord extends DeliveryIdentity {
  id: string;
  state: DeliveryState;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastError: string | null;
  acceptedAt: Date | null;
  terminalAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeliveryAttemptRecord {
  id: string;
  deliveryId: string;
  leaseOwner: string;
  attemptNumber: number;
  startedAt: Date;
  completedAt: Date | null;
  httpStatus: number | null;
  result: DeliveryAttemptResult;
  errorSummary: string | null;
  nextRetryAt: Date | null;
}

export interface ClaimedDelivery {
  delivery: DeliveryRecord;
  attempt: DeliveryAttemptRecord;
}

export interface ClaimDeliveryOptions extends DeliveryIdentity {
  workerId?: string;
  now?: Date;
  leaseMs?: number;
}

export interface CompleteDeliveryOptions {
  deliveryId: string;
  tenantId: string;
  leaseOwner: string;
  attemptNumber: number;
  result: Exclude<DeliveryAttemptResult, "INTERRUPTED">;
  httpStatus?: number | null;
  errorSummary?: string | null;
  nextRetryAt?: Date | null;
  terminal?: boolean;
  now?: Date;
}

type RawDelivery = DeliveryRecord;
type RawAttempt = DeliveryAttemptRecord;

export const sanitizeDeliveryError = (value: unknown): string => {
  const text = value instanceof Error ? value.message : String(value ?? "unknown error");
  return text.replace(/[\r\n\t]+/g, " ").slice(0, MAX_DELIVERY_ERROR_SUMMARY_LENGTH);
};

export async function ensureDeliveryRecord(
  db: CanonicalEventPrisma,
  options: EnsureDeliveryOptions
): Promise<DeliveryRecord> {
  const nextAttemptAt = options.nextAttemptAt ?? new Date();
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const [row] = await db.$queryRaw<RawDelivery[]>`
    INSERT INTO "CanonicalEventDelivery" (
      "tenantId", "eventId", "destinationId", "maxAttempts", "nextAttemptAt", "updatedAt"
    )
    SELECT ${options.tenantId}, ${options.eventId}, ${options.destinationId}, ${maxAttempts}, ${nextAttemptAt}, NOW()
    FROM "CanonicalEventOutbox"
    WHERE "id" = ${options.eventId} AND "tenantId" = ${options.tenantId}
    ON CONFLICT ("tenantId", "eventId", "destinationId") DO UPDATE SET "updatedAt" = "CanonicalEventDelivery"."updatedAt"
    RETURNING *
  `;
  if (!row) throw new Error("Canonical delivery event does not belong to tenant.");
  return row;
}

export async function claimDelivery(
  db: CanonicalEventPrisma,
  options: ClaimDeliveryOptions
): Promise<ClaimedDelivery | null> {
  const now = options.now ?? new Date();
  const leaseMs = Math.max(1, options.leaseMs ?? DEFAULT_DELIVERY_LEASE_MS);
  const leaseOwner = options.workerId ?? randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);

  return db.$transaction(async (tx) => {
    const [delivery] = await tx.$queryRaw<RawDelivery[]>`
      UPDATE "CanonicalEventDelivery"
      SET
        "state" = 'IN_PROGRESS'::"CanonicalEventDeliveryState",
        "leaseOwner" = ${leaseOwner},
        "leaseExpiresAt" = ${leaseExpiresAt},
        "attemptCount" = "attemptCount" + 1,
        "updatedAt" = ${now}
      WHERE "id" = (
        SELECT "id" FROM "CanonicalEventDelivery"
        WHERE "tenantId" = ${options.tenantId}
          AND "eventId" = ${options.eventId}
          AND "destinationId" = ${options.destinationId}
          AND "state" IN ('PENDING'::"CanonicalEventDeliveryState", 'RETRY_PENDING'::"CanonicalEventDeliveryState", 'IN_PROGRESS'::"CanonicalEventDeliveryState")
          AND "nextAttemptAt" <= ${now}
          AND ("state" != 'IN_PROGRESS'::"CanonicalEventDeliveryState" OR "leaseExpiresAt" <= ${now})
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `;
    if (!delivery) return null;

    const [attempt] = await tx.$queryRaw<RawAttempt[]>`
      INSERT INTO "CanonicalEventDeliveryAttempt" (
        "deliveryId", "leaseOwner", "attemptNumber", "startedAt"
      ) VALUES (
        ${delivery.id}, ${leaseOwner}, ${delivery.attemptCount}, ${now}
      )
      RETURNING *
    `;
    return { delivery, attempt };
  });
}

export async function completeDeliveryAttempt(
  db: CanonicalEventPrisma,
  options: CompleteDeliveryOptions
): Promise<DeliveryRecord | null> {
  const now = options.now ?? new Date();
  const errorSummary = options.errorSummary ? sanitizeDeliveryError(options.errorSummary) : null;
  const state: DeliveryState = options.result === "ACCEPTED"
    ? "ACCEPTED"
    : options.terminal
      ? "FAILED_TERMINAL"
      : "RETRY_PENDING";

  return db.$transaction(async (tx) => {
    const [delivery] = await tx.$queryRaw<RawDelivery[]>`
      UPDATE "CanonicalEventDelivery"
      SET
        "state" = ${state}::"CanonicalEventDeliveryState",
        "leaseOwner" = NULL,
        "leaseExpiresAt" = NULL,
        "nextAttemptAt" = ${options.nextRetryAt ?? now},
        "lastError" = ${errorSummary},
        "acceptedAt" = CASE WHEN ${state} = 'ACCEPTED' THEN ${now} ELSE "acceptedAt" END,
        "terminalAt" = CASE WHEN ${state} = 'FAILED_TERMINAL' THEN ${now} ELSE "terminalAt" END,
        "updatedAt" = ${now}
      WHERE "id" = ${options.deliveryId}
        AND "tenantId" = ${options.tenantId}
        AND "leaseOwner" = ${options.leaseOwner}
        AND "state" = 'IN_PROGRESS'::"CanonicalEventDeliveryState"
      RETURNING *
    `;
    if (!delivery) return null;

    await tx.$executeRaw`
      UPDATE "CanonicalEventDeliveryAttempt"
      SET
        "completedAt" = ${now},
        "httpStatus" = ${options.httpStatus ?? null},
        "result" = ${options.result}::"CanonicalEventDeliveryAttemptResult",
        "errorSummary" = ${errorSummary},
        "nextRetryAt" = ${options.nextRetryAt ?? null}
      WHERE "deliveryId" = ${options.deliveryId}
        AND "leaseOwner" = ${options.leaseOwner}
        AND "attemptNumber" = ${options.attemptNumber}
    `;
    return delivery;
  });
}

export async function listEligibleDeliveries(
  db: CanonicalEventPrisma,
  options: { tenantId: string; destinationId: string; now?: Date; limit?: number }
): Promise<DeliveryRecord[]> {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(1, options.limit ?? 25), 100);
  return db.$queryRaw<RawDelivery[]>`
    SELECT * FROM "CanonicalEventDelivery"
    WHERE "tenantId" = ${options.tenantId}
      AND "destinationId" = ${options.destinationId}
      AND "state" IN ('PENDING'::"CanonicalEventDeliveryState", 'RETRY_PENDING'::"CanonicalEventDeliveryState", 'IN_PROGRESS'::"CanonicalEventDeliveryState")
      AND "nextAttemptAt" <= ${now}
      AND ("state" != 'IN_PROGRESS'::"CanonicalEventDeliveryState" OR "leaseExpiresAt" <= ${now})
    ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
    LIMIT ${limit}
  `;
}

/**
 * Suspends every dispatchable delivery for a destination (PENDING,
 * RETRY_PENDING and IN_PROGRESS) and fences any open attempt.
 *
 * Clearing `leaseOwner` invalidates in-flight leases: a worker that already
 * claimed the delivery can no longer complete the attempt (existing lease
 * fencing), so an endpoint change cannot be observed by the claim path, and
 * in-flight work can never be silently redirected to the replacement URL.
 * Open attempts are recorded as INTERRUPTED so delivery history stays coherent.
 *
 * Never opens a nested transaction: the caller must run this in the same
 * transaction as the destination URL update so both commit or neither.
 */
export async function suspendDeliveriesForDestination(
  db: CanonicalEventPrisma,
  options: { tenantId: string; destinationId: string }
): Promise<number> {
  const suspended = await db.$executeRaw`
    UPDATE "CanonicalEventDelivery"
    SET
      "state" = 'SUSPENDED'::"CanonicalEventDeliveryState",
      "leaseOwner" = NULL,
      "leaseExpiresAt" = NULL,
      "updatedAt" = NOW()
    WHERE "tenantId" = ${options.tenantId}
      AND "destinationId" = ${options.destinationId}
      AND "state" IN (
        'PENDING'::"CanonicalEventDeliveryState",
        'RETRY_PENDING'::"CanonicalEventDeliveryState",
        'IN_PROGRESS'::"CanonicalEventDeliveryState"
      )
  `;
  if (suspended > 0) {
    await db.$executeRaw`
      UPDATE "CanonicalEventDeliveryAttempt"
      SET
        "completedAt" = NOW(),
        "result" = 'INTERRUPTED'::"CanonicalEventDeliveryAttemptResult",
        "errorSummary" = 'Suspended: destination endpoint changed'
      WHERE "completedAt" IS NULL
        AND "deliveryId" IN (
          SELECT "id" FROM "CanonicalEventDelivery"
          WHERE "tenantId" = ${options.tenantId}
            AND "destinationId" = ${options.destinationId}
            AND "state" = 'SUSPENDED'::"CanonicalEventDeliveryState"
        )
    `;
  }
  return suspended;
}

/**
 * Resumes all SUSPENDED deliveries for a destination back to PENDING.
 * Returns the count of resumed deliveries.
 */
export async function resumeDeliveriesForDestination(
  db: CanonicalEventPrisma,
  options: { tenantId: string; destinationId: string }
): Promise<number> {
  const result = await db.$executeRaw`
    UPDATE "CanonicalEventDelivery"
    SET
      "state" = 'PENDING'::"CanonicalEventDeliveryState",
      "nextAttemptAt" = NOW(),
      "updatedAt" = NOW()
    WHERE "tenantId" = ${options.tenantId}
      AND "destinationId" = ${options.destinationId}
      AND "state" = 'SUSPENDED'::"CanonicalEventDeliveryState"
  `;
  return result;
}

/**
 * Lists all SUSPENDED deliveries for a destination, including event type
 * and last attempt summary.
 */
export async function listSuspendedDeliveriesForDestination(
  db: CanonicalEventPrisma,
  options: { tenantId: string; destinationId: string; limit?: number }
): Promise<DeliveryRecord[]> {
  const limit = Math.min(Math.max(1, options.limit ?? 100), 500);
  return db.$queryRaw<RawDelivery[]>`
    SELECT * FROM "CanonicalEventDelivery"
    WHERE "tenantId" = ${options.tenantId}
      AND "destinationId" = ${options.destinationId}
      AND "state" = 'SUSPENDED'::"CanonicalEventDeliveryState"
    ORDER BY "createdAt" ASC
    LIMIT ${limit}
  `;
}

export async function getDeliveryRecord(
  db: CanonicalEventPrisma,
  identity: DeliveryIdentity
): Promise<DeliveryRecord | null> {
  const [row] = await db.$queryRaw<RawDelivery[]>`
    SELECT * FROM "CanonicalEventDelivery"
    WHERE "tenantId" = ${identity.tenantId}
      AND "eventId" = ${identity.eventId}
      AND "destinationId" = ${identity.destinationId}
    LIMIT 1
  `;
  return row ?? null;
}

export async function listDeliveryAttempts(
  db: CanonicalEventPrisma,
  deliveryId: string,
  limit = 25
): Promise<DeliveryAttemptRecord[]> {
  return db.$queryRaw<RawAttempt[]>`
    SELECT * FROM "CanonicalEventDeliveryAttempt"
    WHERE "deliveryId" = ${deliveryId}
    ORDER BY "attemptNumber" ASC
    LIMIT ${Math.min(Math.max(1, limit), 100)}
  `;
}

export async function createDeliveryForEvent(
  db: CanonicalEventPrisma,
  options: EnsureDeliveryOptions
): Promise<DeliveryRecord> {
  return ensureDeliveryRecord(db, options).catch((error) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") throw error;
    throw error;
  });
}
