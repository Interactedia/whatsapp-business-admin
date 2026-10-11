import type { Worker } from "bullmq";
import {
  JOB_TYPES,
  QUEUE_NAMES,
  createWorker,
  validateJobPayload,
  type InboundWebhookJobPayload,
} from "@/lib/queue";
import { processInboundWebhookJob, type InboundProcessingResult } from "./processor";

export function createInboundWebhookWorker(options?: {
  concurrency?: number;
  onFailed?: (jobId: string | undefined, error: Error) => void;
}): Worker<InboundWebhookJobPayload, InboundProcessingResult> {
  return createWorker<InboundWebhookJobPayload, InboundProcessingResult>(
    QUEUE_NAMES.INBOUND_WEBHOOK,
    async (job) => {
      const payload = validateJobPayload(job.data);
      if (payload.type !== JOB_TYPES.INBOUND_WEBHOOK) throw new Error(`Unsupported inbound job type ${payload.type}`);
      return processInboundWebhookJob(payload);
    },
    {
      concurrency: options?.concurrency,
      onFailed: (job, error) => options?.onFailed?.(job?.id, error),
    },
  );
}
