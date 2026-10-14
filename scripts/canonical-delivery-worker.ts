#!/usr/bin/env tsx
/**
 * WA-STAB-010 — Canonical webhook delivery worker (runtime companion to ERA 3).
 *
 * Polls every active `WebhookDestination` (per `deliverCanonicalEventHttp` SSRF
 * policy) and dispatches each pending `CanonicalEventDelivery` row through the
 * established building blocks:
 *   listEligibleDeliveries  → claimDelivery (FOR UPDATE SKIP LOCKED)
 *   → deliverCanonicalEventHttp (validates URL, signs HMAC, posts JSON)
 *   → completeDeliveryAttempt (records outcome, retries, terminal).
 *
 * No new mechanism, no schema change, no public contract change. The lease
 * semantics already in `CanonicalEventDelivery` make concurrent processes
 * safe; restart resilience is automatic because the durable delivery row is
 * the source of truth.
 */
import { randomUUID } from "node:crypto";
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";
import {
  type CanonicalEventOutboxRecord,
} from "@/lib/events/outbox";
import {
  claimDelivery,
  completeDeliveryAttempt,
  listEligibleDeliveries,
  sanitizeDeliveryError,
  type DeliveryAttemptResult,
} from "@/lib/events/delivery-state";
import {
  classifyCanonicalDeliveryResult,
  deliverCanonicalEventHttp,
  DEFAULT_DELIVERY_BATCH_SIZE,
  DEFAULT_DELIVERY_CONCURRENCY,
  DEFAULT_DELIVERY_TIMEOUT_MS,
  MAX_DELIVERY_TIMEOUT_MS,
  type CanonicalWebhookDestination,
} from "@/lib/events/delivery";
import { EXTERNAL_EVENT_TYPES, type ExternalEventType } from "@/lib/events/contract";
import { validateExternalEvent } from "@/lib/events/validation";

const DEFAULT_POLL_MS = 1_500;

const POLL_MS = Number(process.env.CANONICAL_DELIVERY_POLL_MS || DEFAULT_POLL_MS);
const BATCH_SIZE = Number(process.env.CANONICAL_DELIVERY_BATCH_SIZE || DEFAULT_DELIVERY_BATCH_SIZE);
const CONCURRENCY = Number(process.env.CANONICAL_DELIVERY_CONCURRENCY || DEFAULT_DELIVERY_CONCURRENCY);
const TIMEOUT_MS = Number(process.env.CANONICAL_DELIVERY_TIMEOUT_MS || DEFAULT_DELIVERY_TIMEOUT_MS);
const LEASE_MS = Number(process.env.CANONICAL_DELIVERY_LEASE_MS || 45_000);

// ponytail: opt-in test escape hatch. Defaults to false so production SSRF
// guarantees hold. The HTTP transport still refuses any non-loopback private
// address even with this on (see resolveSafeUrl). Only valid for the
// Canonical Webhook E2E suite that points at a localhost receiver.
const ALLOW_LOOPBACK_FOR_TESTS =
  process.env.CANONICAL_DELIVERY_ALLOW_LOOPBACK_FOR_TEST === "true" ||
  process.env.NODE_ENV === "test";

const workerId = `canonical-delivery-${process.pid}-${randomUUID().slice(0, 8)}`;

interface WorkerDestination {
  tenantId: string;
  destination: CanonicalWebhookDestination;
  subscriptions: Set<ExternalEventType>;
}

async function listActiveDestinations(): Promise<WorkerDestination[]> {
  const rows = await prisma.webhookDestination.findMany({
    where: { enabled: true, retiredAt: null },
    select: {
      id: true,
      tenantId: true,
      endpointUrl: true,
      signingSecretEnc: true,
      subscriptions: true,
    },
  });
  const out: WorkerDestination[] = [];
  for (const row of rows) {
    const validSubs = new Set<ExternalEventType>();
    const supportedTypes = Object.values(EXTERNAL_EVENT_TYPES) as string[];
    for (const sub of row.subscriptions) {
      if (supportedTypes.includes(sub)) {
        validSubs.add(sub as ExternalEventType);
      }
    }
    out.push({
      tenantId: row.tenantId,
      destination: {
        id: row.id,
        tenantId: row.tenantId,
        url: row.endpointUrl,
        signingSecret: decrypt(row.signingSecretEnc),
      },
      subscriptions: validSubs,
    });
  }
  return out;
}

async function loadEvent(tenantId: string, eventId: string): Promise<CanonicalEventOutboxRecord | null> {
  const [row] = await prisma.$queryRaw<Array<{
    id: string;
    tenantId: string;
    eventType: string;
    contractVersion: number;
    payload: unknown;
    payloadHash: string;
    occurredAt: Date;
    recordedAt: Date;
    createdAt: Date;
  }>>`
    SELECT * FROM "CanonicalEventOutbox"
    WHERE "tenantId" = ${tenantId} AND "id" = ${eventId}
    LIMIT 1
  `;
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    eventType: row.eventType as ExternalEventType,
    contractVersion: row.contractVersion,
    payload: row.payload as never,
    payloadHash: row.payloadHash,
    occurredAt: row.occurredAt,
    recordedAt: row.recordedAt,
    createdAt: row.createdAt,
  };
}

interface DispatchOutcome {
  outcome: "ACCEPTED" | "RETRYABLE" | "TERMINAL" | "INTERRUPTED" | "SKIPPED";
}

async function dispatchOne(worker: WorkerDestination, delivery: Awaited<ReturnType<typeof listEligibleDeliveries>>[number]): Promise<DispatchOutcome> {
  const event = await loadEvent(worker.tenantId, delivery.eventId);
  if (!event) {
    console.error("[canonical-delivery-worker] outbox event missing", { tenantId: worker.tenantId, eventId: delivery.eventId });
    return { outcome: "INTERRUPTED" };
  }
  if (!worker.subscriptions.has(event.eventType)) {
    // Defense-in-depth: fanout should not materialize deliveries for events
    // the destination is not subscribed to. If we somehow see one, suspend
    // it permanently so URL-change policy is not silently crossed.
    const claimed = await claimDelivery(prisma, {
      tenantId: worker.tenantId,
      eventId: delivery.eventId,
      destinationId: worker.destination.id,
      workerId,
      leaseMs: LEASE_MS,
    });
    if (claimed) {
      // INTERRUPTED is set via the suspend/resume path (see
      // suspendDeliveriesForDestination). Use TERMINAL here so the row leaves
      // the eligible queue and never spams the destination with retries.
      await completeDeliveryAttempt(prisma, {
        deliveryId: claimed.delivery.id,
        tenantId: worker.tenantId,
        leaseOwner: claimed.attempt.leaseOwner,
        attemptNumber: claimed.attempt.attemptNumber,
        result: "TERMINAL",
        errorSummary: sanitizeDeliveryError("destination not subscribed"),
        nextRetryAt: null,
      });
    }
    return { outcome: "TERMINAL" };
  }

  const claimed = await claimDelivery(prisma, {
    tenantId: worker.tenantId,
    eventId: delivery.eventId,
    destinationId: worker.destination.id,
    workerId,
    leaseMs: LEASE_MS,
  });
  if (!claimed) return { outcome: "SKIPPED" }; // sibling worker won the race.

  const timeoutMs = Math.max(1, Math.min(TIMEOUT_MS, MAX_DELIVERY_TIMEOUT_MS));
  let httpResult;
  try {
    // ponytail: validateExternalEvent is a no-op for trusted internal callers,
    // but `deliverCanonicalEventHttp` re-runs it inside an explicit transport.
    // We re-run here so the HTTP path benefits from the same payload discipline.
    validateExternalEvent(event.payload);
    httpResult = await deliverCanonicalEventHttp(worker.destination, event.payload as never, {
      timeoutMs,
      allowLoopbackForTests: ALLOW_LOOPBACK_FOR_TESTS,
    });
  } catch (error) {
    httpResult = {
      status: "network_error",
      eventId: event.id,
      destinationId: worker.destination.id,
      tenantId: worker.tenantId,
      error: error instanceof Error ? error.message : String(error),
    } as never;
  }
  const classification = classifyCanonicalDeliveryResult(httpResult);
  let nextRetryAt: Date | null = null;
  const terminal = classification.terminal;
  const rawHttpStatus = "httpStatus" in httpResult ? httpResult.httpStatus : null;
  if (classification.attemptResult === "RETRYABLE") {
    const retryDelayMs = typeof classification.retryAfter === "string"
      ? Number.parseInt(classification.retryAfter, 10) * 1000 || 5_000
      : 5_000;
    const safeRetryMs = Math.max(1_000, Math.min(Number.isFinite(retryDelayMs) ? retryDelayMs : 5_000, 5 * 60_000));
    nextRetryAt = new Date(Date.now() + safeRetryMs);
  }
  const attemptResult = terminal ? "TERMINAL" : classification.attemptResult;
  // ponytail: completeDeliveryAttempt forbids INTERRUPTED here; that's reserved
  // for the suspend/resume path which sets state directly. We only ever call
  // it with ACCEPTED / RETRYABLE / TERMINAL (terminal only when retries are
  // exhausted or the destination is permanently invalid).
  const safeResult: Exclude<DeliveryAttemptResult, "INTERRUPTED"> = attemptResult === "INTERRUPTED" ? "TERMINAL" : attemptResult;
  await completeDeliveryAttempt(prisma, {
    deliveryId: claimed.delivery.id,
    tenantId: worker.tenantId,
    leaseOwner: claimed.attempt.leaseOwner,
    attemptNumber: claimed.attempt.attemptNumber,
    result: safeResult,
    httpStatus: rawHttpStatus,
    errorSummary: safeResult === "ACCEPTED" ? null : sanitizeDeliveryError(classification.errorSummary ?? "delivery failed"),
    nextRetryAt,
  });
  return { outcome: safeResult };
}

async function sweepDestinations(): Promise<{ deliveries: number; accepted: number; retryable: number; terminal: number; interrupted: number; skipped: number; workers: number }> {
  const dests = await listActiveDestinations();
  let deliveries = 0;
  let accepted = 0;
  let retryable = 0;
  let terminal = 0;
  let interrupted = 0;
  let skipped = 0;
  // ponytail: concurrency is bounded; loop simply processes serially per
  // destination. Each `dispatchOne` call holds its own row-level lease via
  // claimDelivery (FOR UPDATE SKIP LOCKED), so multiple workers in this
  // process, and multiple processes, never collide.
  for (const worker of dests) {
    const eligible = await listEligibleDeliveries(prisma, {
      tenantId: worker.tenantId,
      destinationId: worker.destination.id,
      limit: Math.max(1, Math.min(BATCH_SIZE, 100)),
    });
    for (const delivery of eligible) {
      deliveries += 1;
      const { outcome } = await dispatchOne(worker, delivery);
      switch (outcome) {
        case "ACCEPTED": accepted += 1; break;
        case "RETRYABLE": retryable += 1; break;
        case "TERMINAL": terminal += 1; break;
        case "INTERRUPTED": interrupted += 1; break;
        case "SKIPPED": skipped += 1; break;
      }
    }
  }
  return { deliveries, accepted, retryable, terminal, interrupted, skipped, workers: dests.length };
}

let inFlight = false;
let stopping = false;

async function pollOnce(): Promise<void> {
  if (inFlight || stopping) return;
  inFlight = true;
  try {
    const summary = await sweepDestinations();
    if (summary.deliveries > 0) {
      console.log("[canonical-delivery-worker] sweep", summary);
    }
  } catch (error) {
    console.error("[canonical-delivery-worker] sweep crashed", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    inFlight = false;
  }
}

let timer: NodeJS.Timeout | undefined;
function startTicker(): void {
  timer = setInterval(() => { void pollOnce(); }, POLL_MS);
  // Kick once immediately so startup latency is one poll, not POLL_MS.
  void pollOnce();
}

async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[canonical-delivery-worker] ${signal} received, stopping (id=${workerId})`);
  if (timer) clearInterval(timer);
  const deadline = Date.now() + 10_000;
  while (inFlight && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

await prisma.$queryRaw`SELECT 1`;
startTicker();
console.log(`[canonical-delivery-worker] ready (id=${workerId}, pollMs=${POLL_MS}, batchSize=${BATCH_SIZE}, concurrency=${CONCURRENCY})`);
