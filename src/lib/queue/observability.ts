import { Queue } from "bullmq";
import { getBullMQConnectionOptions } from "./connection";
import { getQueueConfig, QUEUE_NAMES } from "./config";
import { isQueueConfigured } from "@/lib/queue";
import { inspectQueue, type QueueInspectionResult } from "./inspection";

export type QueueMetric =
  | { name: string; available: true; result: QueueInspectionResult }
  | { name: string; available: false; error: string };

export interface QueueObservabilitySummary {
  available: boolean;
  queues: QueueMetric[];
  collectedAt: string;
}

function sanitizeError(error: unknown): string {
  return error instanceof Error ? error.name || "QueueInspectionError" : "QueueInspectionError";
}

export async function collectQueueObservability(): Promise<QueueObservabilitySummary> {
  const collectedAt = new Date().toISOString();
  const names = Object.values(QUEUE_NAMES);

  if (!isQueueConfigured()) {
    return {
      available: false,
      queues: names.map((name) => ({ name, available: false, error: "Redis is not configured" })),
      collectedAt,
    };
  }

  const config = getQueueConfig();
  const connection = getBullMQConnectionOptions();

  const queues = await Promise.all(
    names.map(async (name): Promise<QueueMetric> => {
      const queue = new Queue(name, { prefix: config.prefix, connection });
      try {
        return { name, available: true, result: await inspectQueue(queue) };
      } catch (error) {
        return { name, available: false, error: sanitizeError(error) };
      } finally {
        await queue.close().catch(() => undefined);
      }
    })
  );

  return {
    available: queues.every((queue) => queue.available),
    queues,
    collectedAt,
  };
}
