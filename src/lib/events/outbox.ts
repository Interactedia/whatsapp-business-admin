import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { AnyExternalEvent, ExternalEventType } from "@/lib/events/contract";
import { validateExternalEvent } from "@/lib/events/validation";

export type CanonicalEventPrisma = Prisma.TransactionClient | typeof prisma;

export class CanonicalEventOutboxConflictError extends Error {
  constructor(public readonly eventId: string) {
    super(`Canonical event id already exists with different payload: ${eventId}`);
    this.name = "CanonicalEventOutboxConflictError";
  }
}

export interface CanonicalEventOutboxRecord {
  id: string;
  tenantId: string;
  eventType: ExternalEventType;
  contractVersion: number;
  payload: AnyExternalEvent;
  payloadHash: string;
  occurredAt: Date;
  recordedAt: Date;
  createdAt: Date;
}

export interface ListCanonicalEventsOptions {
  tenantId: string;
  limit?: number;
  afterCreatedAt?: Date;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
};

export const canonicalEventPayloadHash = (event: AnyExternalEvent): string =>
  createHash("sha256").update(stableJson(event)).digest("hex");

type RawCanonicalEventRow = {
  id: string;
  tenantId: string;
  eventType: string;
  contractVersion: number;
  payload: unknown;
  payloadHash: string;
  occurredAt: Date;
  recordedAt: Date;
  createdAt: Date;
};

const rowToRecord = (row: RawCanonicalEventRow): CanonicalEventOutboxRecord => ({
  ...row,
  eventType: row.eventType as ExternalEventType,
  payload: validateExternalEvent(row.payload),
});

export async function addCanonicalEvent(
  db: CanonicalEventPrisma,
  input: unknown,
): Promise<CanonicalEventOutboxRecord> {
  const event = validateExternalEvent(input);
  const payloadHash = canonicalEventPayloadHash(event);
  const [row] = await db.$queryRaw<RawCanonicalEventRow[]>`
    INSERT INTO "CanonicalEventOutbox" (
      "id", "tenantId", "eventType", "contractVersion", "payload", "payloadHash", "occurredAt", "recordedAt"
    ) VALUES (
      ${event.id},
      ${event.tenantId},
      ${event.type},
      ${event.version},
      ${event as unknown as Prisma.InputJsonValue},
      ${payloadHash},
      ${new Date(event.occurredAt)},
      ${new Date(event.recordedAt)}
    )
    ON CONFLICT ("id") DO UPDATE SET "id" = EXCLUDED."id"
      WHERE "CanonicalEventOutbox"."payloadHash" = EXCLUDED."payloadHash"
    RETURNING *
  `;
  if (!row) throw new CanonicalEventOutboxConflictError(event.id);
  return rowToRecord(row);
}

export async function getCanonicalEvent(
  db: CanonicalEventPrisma,
  tenantId: string,
  id: string,
): Promise<CanonicalEventOutboxRecord | null> {
  const row = await db.canonicalEventOutbox.findFirst({ where: { id, tenantId } });
  return row ? rowToRecord(row) : null;
}

export async function listCanonicalEvents(
  db: CanonicalEventPrisma,
  options: ListCanonicalEventsOptions,
): Promise<CanonicalEventOutboxRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const rows = await db.canonicalEventOutbox.findMany({
    where: {
      tenantId: options.tenantId,
      ...(options.afterCreatedAt ? { createdAt: { gt: options.afterCreatedAt } } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  return rows.map(rowToRecord);
}
