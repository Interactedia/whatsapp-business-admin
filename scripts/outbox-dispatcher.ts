#!/usr/bin/env tsx
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { OutboxDispatcher } from "@/lib/outbox/dispatcher";

const dispatcher = new OutboxDispatcher({
  dispatcherId: process.env.OUTBOX_DISPATCHER_ID || `outbox-dispatcher-${process.pid}`,
  batchSize: Number(process.env.OUTBOX_DISPATCH_LIMIT || 50),
  leaseMs: Number(process.env.OUTBOX_DISPATCH_LEASE_MS || 30_000),
  retryDelayMs: Number(process.env.OUTBOX_DISPATCH_RETRY_DELAY_MS || 5_000),
  pollMs: Number(process.env.OUTBOX_DISPATCH_POLL_MS || 1_000),
});

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[outbox-dispatcher] ${signal} received, stopping`);
  await dispatcher.stop();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

await prisma.$queryRaw`SELECT 1`;
dispatcher.start();
console.log("[outbox-dispatcher] ready");
