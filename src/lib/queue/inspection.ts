/**
 * Programmatic queue operational inspection.
 *
 * Invariants:
 * - Credentials never exposed in metrics or outputs.
 * - Non-destructive read-only queries.
 * - Structured inspection result.
 */

import type { Queue } from "bullmq";

export interface QueueJobCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  prioritized: number;
  waitingChildren: number;
}

export interface QueueInspectionResult {
  name: string;
  isPaused: boolean;
  counts: QueueJobCounts;
  total: number;
  timestamp: string;
}

/**
 * Inspects a queue's state and job counts.
 */
export async function inspectQueue(queue: Queue): Promise<QueueInspectionResult> {
  const [counts, isPaused] = await Promise.all([
    queue.getJobCounts(
      "waiting",
      "active",
      "completed",
      "failed",
      "delayed",
      "prioritized",
      "waiting-children"
    ),
    queue.isPaused(),
  ]);

  const waiting = counts.waiting ?? 0;
  const active = counts.active ?? 0;
  const completed = counts.completed ?? 0;
  const failed = counts.failed ?? 0;
  const delayed = counts.delayed ?? 0;
  const prioritized = counts.prioritized ?? 0;
  const waitingChildren = counts["waiting-children"] ?? 0;

  const total =
    waiting + active + completed + failed + delayed + prioritized + waitingChildren;

  return {
    name: queue.name,
    isPaused,
    counts: {
      waiting,
      active,
      completed,
      failed,
      delayed,
      prioritized,
      waitingChildren,
    },
    total,
    timestamp: new Date().toISOString(),
  };
}
