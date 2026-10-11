import type { Worker } from "bullmq";
import {
  JOB_TYPES,
  QUEUE_NAMES,
  createWorker,
  validateJobPayload,
  type StatusReconciliationJobPayload,
} from "@/lib/queue";
import { processStatusReconciliationJob } from "./processor";
import type { StatusReconciliationResult } from "./reconciliation";

export function createStatusReconciliationWorker(options?: {
  concurrency?: number;
  onFailed?: (jobId: string | undefined, error: Error) => void;
}): Worker<StatusReconciliationJobPayload, StatusReconciliationResult> {
  return createWorker<StatusReconciliationJobPayload, StatusReconciliationResult>(
    QUEUE_NAMES.STATUS_RECONCILIATION,
    async (job) => {
      const payload = validateJobPayload(job.data);
      if (payload.type !== JOB_TYPES.STATUS_RECONCILIATION) {
        throw new Error(`Unsupported status job type ${payload.type}`);
      }
      return processStatusReconciliationJob(payload);
    },
    {
      concurrency: options?.concurrency,
      onFailed: (job, error) => options?.onFailed?.(job?.id, error),
    },
  );
}
