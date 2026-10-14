#!/usr/bin/env tsx
/**
 * WA-STAB-010 — Canonical fanout dispatcher (runtime companion to ERA 3 wiring).
 *
 * Mirrors `scripts/outbox-dispatcher.ts`: an in-process poller that drives
 * the existing `fanoutCanonicalEvent` service. No scheduler, no BullMQ job,
 * no schema change — it reuses the ERA 3 contract exactly.
 *
 * Operates only on events in `CanonicalEventOutbox` whose payload/event type
 * is subscribed to by at least one active `WebhookDestination` for the same
 * tenant. Fanout is idempotent: `CanonicalEventDelivery` carries a unique
 * `(tenantId, eventId, destinationId)` constraint, so re-running over an
 * already-processed event is a no-op.
 *
 * Restart resilience: a small per-process cursor persisted to
 * `/tmp/wba-fanout-cursor.json` records the highest `createdAt` timestamp
 * already swept. On start, the cursor is reloaded; if missing (first boot or
 * operator cleared it), the sweep window defaults to `CANONICAL_FANOUT_LOOKBACK_MS`
 * milliseconds before "now" so commit-then-crash windows are always
 * reconciled.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import {
  fanoutCanonicalEvent,
  type FanoutResult,
} from "@/lib/events/fanout";
import { EXTERNAL_EVENT_TYPES } from "@/lib/events/contract";

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_LOOKBACK_MS = 60 * 60 * 1000; // 1h
const DEFAULT_SCAN_BATCH = 100;
const CURSOR_FILE = "/tmp/wba-fanout-cursor.json";

const POLL_MS = Number(process.env.CANONICAL_FANOUT_POLL_MS || DEFAULT_POLL_MS);
const BATCH_SIZE = Number(process.env.CANONICAL_FANOUT_BATCH_SIZE || DEFAULT_BATCH_SIZE);
const LOOKBACK_MS = Number(process.env.CANONICAL_FANOUT_LOOKBACK_MS || DEFAULT_LOOKBACK_MS);
const SCAN_BATCH = Number(process.env.CANONICAL_FANOUT_SCAN_BATCH || DEFAULT_SCAN_BATCH);

const dispatcherId = `canonical-fanout-${process.pid}-${randomUUID().slice(0, 8)}`;

interface CursorState {
  lastCreatedAt: string; // ISO timestamp
}

function loadCursor(): Date | null {
  if (!existsSync(CURSOR_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(CURSOR_FILE, "utf-8")) as CursorState;
    const ts = new Date(raw.lastCreatedAt);
    if (Number.isNaN(ts.getTime())) return null;
    return ts;
  } catch {
    return null;
  }
}

function saveCursor(ts: Date): void {
  const payload: CursorState = { lastCreatedAt: ts.toISOString() };
  // ponytail: atomic write via temp+rename would be nice; here the file is
  // a single line JSON overwritten by a single fs.writeFileSync. Worst case
  // we replay one extra window, which the idempotent fanout absorbs.
  writeFileSync(CURSOR_FILE, JSON.stringify(payload));
}

let afterCreatedAt: Date | null = loadCursor();
if (afterCreatedAt === null) {
  afterCreatedAt = new Date(Date.now() - LOOKBACK_MS);
  console.log(`[canonical-fanout-dispatcher] cursor missing; starting lookback at ${afterCreatedAt.toISOString()}`);
} else {
  console.log(`[canonical-fanout-dispatcher] cursor loaded: ${afterCreatedAt.toISOString()}`);
}

let stopping = false;
let inFlight = false;

interface DestinationSubscription {
  tenantId: string;
  destinationId: string;
  eventTypes: string[];
}

async function listActiveSubscriptions(): Promise<DestinationSubscription[]> {
  const rows = await prisma.webhookDestination.findMany({
    where: { enabled: true, retiredAt: null },
    select: { id: true, tenantId: true, subscriptions: true },
  });
  return rows.map((row) => ({
    tenantId: row.tenantId,
    destinationId: row.id,
    eventTypes: row.subscriptions,
  }));
}

async function sweepOnce(): Promise<{ matchedEvents: number; processedEvents: number; createdDeliveries: number; failed: number; newCursor: Date | null }> {
  const subs = await listActiveSubscriptions();
  if (subs.length === 0) {
    return { matchedEvents: 0, processedEvents: 0, createdDeliveries: 0, failed: 0, newCursor: null };
  }
  const subscribedTypes = new Set<string>();
  const tenantEventTypes = new Map<string, Set<string>>();
  const supportedTypes = new Set<string>(Object.values(EXTERNAL_EVENT_TYPES) as string[]);
  for (const sub of subs) {
    for (const eventType of sub.eventTypes) {
      subscribedTypes.add(eventType);
      if (!supportedTypes.has(eventType)) continue;
      const set = tenantEventTypes.get(sub.tenantId) ?? new Set<string>();
      set.add(eventType);
      tenantEventTypes.set(sub.tenantId, set);
    }
  }

  let matchedEvents = 0;
  let processedEvents = 0;
  let createdDeliveries = 0;
  let failed = 0;
  let maxSeenCreatedAt: Date | null = null;

  for (const [tenantId, eventTypes] of tenantEventTypes) {
    const cursor = afterCreatedAt;
    // ponytail: bounded loop. The poll pulls up to SCAN_BATCH newest events for
    // the tenant filtered to subscribed types; if the scan is saturated we
    // continue with offset on the next sweep cycle.
    for (let offset = 0; offset < SCAN_BATCH; ) {
      const rows = await prisma.canonicalEventOutbox.findMany({
        where: {
          tenantId,
          eventType: { in: Array.from(eventTypes) },
          createdAt: { gt: cursor ?? new Date(0) },
        },
        orderBy: { createdAt: "asc" },
        take: BATCH_SIZE,
        skip: offset,
        select: { id: true, createdAt: true },
      });
      if (rows.length === 0) break;
      matchedEvents += rows.length;
      offset += rows.length;

      for (const row of rows) {
        if (row.createdAt > (maxSeenCreatedAt ?? new Date(0))) maxSeenCreatedAt = row.createdAt;
        try {
          const result: FanoutResult = await fanoutCanonicalEvent(prisma, { tenantId, eventId: row.id });
          processedEvents += 1;
          createdDeliveries += result.created;
          failed += result.failed;
        } catch (error) {
          failed += 1;
          console.error("[canonical-fanout-dispatcher] fanout failed", { tenantId, eventId: row.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (rows.length < BATCH_SIZE) break;
    }
  }

  if (maxSeenCreatedAt !== null) {
    afterCreatedAt = maxSeenCreatedAt;
    saveCursor(afterCreatedAt);
  }
  return { matchedEvents, processedEvents, createdDeliveries, failed, newCursor: maxSeenCreatedAt };
}

async function pollLoop(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const summary = await sweepOnce();
    if (summary.matchedEvents > 0) {
      console.log("[canonical-fanout-dispatcher] sweep", summary);
    }
  } catch (error) {
    console.error("[canonical-fanout-dispatcher] sweep crashed", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    inFlight = false;
  }
}

let timer: NodeJS.Timeout | undefined;
function startTicker(): void {
  timer = setInterval(() => {
    if (stopping || inFlight) return;
    void pollLoop();
  }, POLL_MS);
}

async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[canonical-fanout-dispatcher] ${signal} received, stopping (id=${dispatcherId})`);
  if (timer) clearInterval(timer);
  // Drain in-flight work with a bounded wait.
  const deadline = Date.now() + 5_000;
  while (inFlight && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

await prisma.$queryRaw`SELECT 1`;
startTicker();
console.log(`[canonical-fanout-dispatcher] ready (id=${dispatcherId}, pollMs=${POLL_MS}, batchSize=${BATCH_SIZE})`);
