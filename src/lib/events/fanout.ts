/**
 * WA-ERA3-07-FANOUT — Post-commit canonical subscription fanout.
 *
 * Converts a committed canonical event into one durable delivery record per
 * eligible subscribed webhook destination, bounded by tenant ownership.
 *
 * Invariants (see IMPLEMENTATION_PACKET WA-ERA3-07-FANOUT):
 * - Operates only on committed canonical events already persisted in
 *   `CanonicalEventOutbox`; it never mutates or deletes outbox rows.
 * - Eligibility is evaluated against destination configuration at fanout time:
 *   same `tenantId`, `enabled = true`, `retiredAt = null`, and the event type
 *   appears in the destination's `subscriptions` list.
 * - One logical delivery per `(tenantId, eventId, destinationId)`. Database
 *   uniqueness is the source of truth; repeated fanout is idempotent.
 * - Per-destination failures are reported explicitly; successful deliveries in
 *   the same batch are preserved.
 * - No HTTP requests, no automatic dispatch, no scheduler. The service is
 *   invoked explicitly by tests and future operational orchestration.
 */

import {
  getCanonicalEvent,
  type CanonicalEventOutboxRecord,
  type CanonicalEventPrisma,
} from "@/lib/events/outbox";
import {
  listEligibleWebhookDestinations,
  type EligibleFanoutDestination,
  type WebhookDestinationPrisma,
} from "@/lib/events/webhook-destinations";
import { ensureDeliveryRecord, type DeliveryRecord } from "@/lib/events/delivery-state";
import type { Prisma } from "@/generated/prisma/client";

export const MAX_FANOUT_DESTINATIONS_PER_INVOCATION = 500;

export type FanoutDestinationOutcome =
  | {
      status: "created";
      destinationId: string;
      deliveryId: string;
      tenantId: string;
      eventId: string;
      created: false;
      state: DeliveryRecord["state"];
      attemptCount: number;
    }
  | {
      status: "already_exists";
      destinationId: string;
      deliveryId: string;
      tenantId: string;
      eventId: string;
      created: false;
      state: DeliveryRecord["state"];
      attemptCount: number;
    }
  | {
      status: "failed";
      destinationId: string;
      tenantId: string;
      eventId: string;
      created: false;
      error: string;
    };

export interface FanoutResult {
  tenantId: string;
  eventId: string;
  eventType: CanonicalEventOutboxRecord["eventType"];
  discoveredDestinations: number;
  created: number;
  alreadyExists: number;
  failed: number;
  outcomes: FanoutDestinationOutcome[];
}

export class FanoutError extends Error {
  constructor(
    public readonly code: "EVENT_NOT_FOUND" | "TENANT_MISMATCH" | "UNSUPPORTED_EVENT_TYPE" | "INVALID_INPUT",
    message: string
  ) {
    super(message);
    this.name = "FanoutError";
  }
}

export interface FanoutCanonicalEventOptions {
  tenantId: string;
  eventId: string;
  now?: Date;
  maxDestinations?: number;
}

/**
 * Explicit, idempotent post-commit fanout for a single canonical event.
 *
 * The function is intentionally synchronous in the sense that it does not
 * schedule itself, retry itself, or perform network delivery. The supplied
 * `now` is forwarded to delivery-state creation so the resulting `nextAttemptAt`
 * is deterministic in tests.
 */
export async function fanoutCanonicalEvent(
  db: FanoutDatabase,
  options: FanoutCanonicalEventOptions
): Promise<FanoutResult> {
  assertValidInput(options);
  const event = await loadCommittedEvent(db, options.tenantId, options.eventId);
  const eligibilityLimit = Math.max(
    1,
    Math.min(MAX_FANOUT_DESTINATIONS_PER_INVOCATION, options.maxDestinations ?? MAX_FANOUT_DESTINATIONS_PER_INVOCATION)
  );
  const eligible = await listEligibleWebhookDestinations(db, {
    tenantId: event.tenantId,
    eventType: event.eventType,
    limit: eligibilityLimit,
  });
  return materializeFanout(db, event, eligible, options.now);
}

/**
 * Database handle accepted by the fanout service. Either the global Prisma
 * client or a `prisma.$transaction(async tx => ...)` client. Keeping the type
 * narrow allows integration tests to run fanout inside a real PostgreSQL
 * transaction for concurrency safety verification.
 */
export type FanoutDatabase = WebhookDestinationPrisma & CanonicalEventPrisma;

type DeliveryCreationOutcome =
  | { kind: "created"; record: DeliveryRecord }
  | { kind: "already_exists"; record: DeliveryRecord };

async function materializeFanout(
  db: FanoutDatabase,
  event: CanonicalEventOutboxRecord,
  eligible: EligibleFanoutDestination[],
  now: Date | undefined
): Promise<FanoutResult> {
  const outcomes: FanoutDestinationOutcome[] = [];
  let created = 0;
  let alreadyExists = 0;
  let failed = 0;

  for (const destination of eligible) {
    if (destination.tenantId !== event.tenantId) {
      outcomes.push({
        status: "failed",
        destinationId: destination.id,
        tenantId: event.tenantId,
        eventId: event.id,
        created: false,
        error: "Destination does not belong to canonical event tenant.",
      });
      failed += 1;
      continue;
    }
    try {
      const outcome = await createOrFetchDelivery(db, event, destination, now);
      if (outcome.kind === "created") created += 1;
      else alreadyExists += 1;
      outcomes.push({
        status: outcome.kind === "created" ? "created" : "already_exists",
        destinationId: destination.id,
        deliveryId: outcome.record.id,
        tenantId: event.tenantId,
        eventId: event.id,
        created: false,
        state: outcome.record.state,
        attemptCount: outcome.record.attemptCount,
      });
    } catch (err) {
      outcomes.push({
        status: "failed",
        destinationId: destination.id,
        tenantId: event.tenantId,
        eventId: event.id,
        created: false,
        error: err instanceof Error ? err.message : "Unknown delivery creation failure.",
      });
      failed += 1;
    }
  }

  return {
    tenantId: event.tenantId,
    eventId: event.id,
    eventType: event.eventType,
    discoveredDestinations: eligible.length,
    created,
    alreadyExists,
    failed,
    outcomes,
  };
}

async function createOrFetchDelivery(
  db: FanoutDatabase,
  event: CanonicalEventOutboxRecord,
  destination: EligibleFanoutDestination,
  now: Date | undefined
): Promise<DeliveryCreationOutcome> {
  // Pre-check lets us report created vs already_exists deterministically
  // without modifying the existing WA-ERA3-05 ensureDeliveryRecord API. The
  // lookup is a single primary-key read against
  // `@@unique([tenantId, eventId, destinationId])` so it is cheap and
  // race-bounded: the second fanout that loses the race still reports
  // `already_exists` even if its pre-check observed the row as missing,
  // because `ensureDeliveryRecord` short-circuits via `ON CONFLICT DO UPDATE`.
  const existing = await db.canonicalEventDelivery.findFirst({
    where: {
      tenantId: event.tenantId,
      eventId: event.id,
      destinationId: destination.id,
    },
    select: { id: true },
  });
  const ensured = await ensureDeliveryRecord(db, {
    tenantId: event.tenantId,
    eventId: event.id,
    destinationId: destination.id,
    nextAttemptAt: now,
  });
  if (existing) {
    return { kind: "already_exists", record: ensured };
  }
  return { kind: "created", record: ensured };
}

async function loadCommittedEvent(
  db: FanoutDatabase,
  tenantId: string,
  eventId: string
): Promise<CanonicalEventOutboxRecord> {
  const event = await getCanonicalEvent(db, tenantId, eventId);
  if (!event) {
    throw new FanoutError("EVENT_NOT_FOUND", `Canonical event not found: ${eventId}`);
  }
  if (event.tenantId !== tenantId) {
    throw new FanoutError(
      "TENANT_MISMATCH",
      `Canonical event ${eventId} does not belong to tenant ${tenantId}`
    );
  }
  return event;
}

function assertValidInput(options: FanoutCanonicalEventOptions): void {
  if (!options || typeof options.tenantId !== "string" || options.tenantId.length === 0) {
    throw new FanoutError("INVALID_INPUT", "tenantId is required for fanout invocation.");
  }
  if (!options.eventId || typeof options.eventId !== "string") {
    throw new FanoutError("INVALID_INPUT", "eventId is required for fanout invocation.");
  }
}

/**
 * Narrow helper that returns the `Prisma` model delegate required by the
 * fanout service without forcing callers to import the generated client. It
 * exists solely so unit tests and integration tests can build a fanout
 * database handle with a single import.
 */
export type FanoutDbClient = Prisma.TransactionClient | FanoutDatabase;
