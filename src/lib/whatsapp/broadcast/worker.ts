/**
 * BullMQ worker for WhatsApp broadcast dispatch.
 *
 * Consumes BROADCAST_DISPATCH jobs from the wa-broadcast-dispatch queue.
 * Revalidates campaign and tenant ownership, claims execution atomically,
 * invokes Meta API within provider rate limits, and reconciles campaign progress.
 */

import type { Worker } from "bullmq";
import {
  JOB_TYPES,
  QUEUE_NAMES,
  createWorker,
  validateJobPayload,
  type BroadcastDispatchJobPayload,
} from "@/lib/queue";
import {
  handleBroadcastDispatch,
  type BroadcastHandlerDependencies,
  type BroadcastDispatchResult,
} from "./handler";
import {
  BROADCAST_DISPATCH_LIMITER,
  DEFAULT_BROADCAST_WORKER_CONCURRENCY,
} from "./config";

export function createBroadcastDispatchWorker(options?: {
  concurrency?: number;
  limiter?: { max: number; duration: number };
  onFailed?: (jobId: string | undefined, error: Error) => void;
  dependencies?: BroadcastHandlerDependencies;
}): Worker<BroadcastDispatchJobPayload, BroadcastDispatchResult> {
  return createWorker<BroadcastDispatchJobPayload, BroadcastDispatchResult>(
    QUEUE_NAMES.BROADCAST_DISPATCH,
    async (job) => {
      const payload = validateJobPayload(job.data);
      if (payload.type !== JOB_TYPES.BROADCAST_DISPATCH) {
        throw new Error(`Unsupported job type: ${payload.type}`);
      }
      return handleBroadcastDispatch(payload, options?.dependencies);
    },
    {
      concurrency: options?.concurrency ?? DEFAULT_BROADCAST_WORKER_CONCURRENCY,
      limiter: options?.limiter ?? BROADCAST_DISPATCH_LIMITER,
      onFailed: (job, error) => options?.onFailed?.(job?.id, error),
    }
  );
}
