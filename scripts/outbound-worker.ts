#!/usr/bin/env tsx
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { closeAllQueueResources } from "@/lib/queue";
import { createOutboundMessageWorker } from "@/lib/whatsapp/outbound/worker";

const worker = createOutboundMessageWorker({
  concurrency: Number(process.env.OUTBOUND_WORKER_CONCURRENCY || process.env.BULLMQ_WORKER_CONCURRENCY || 5),
  onFailed: (jobId, error) => console.error("[outbound-worker] job failed", { jobId, error: error.message }),
});

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[outbound-worker] ${signal} received, stopping`);
  await worker.close();
  await closeAllQueueResources();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

await prisma.$queryRaw`SELECT 1`;
await worker.waitUntilReady();
console.log("[outbound-worker] ready");
