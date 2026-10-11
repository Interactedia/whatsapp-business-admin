/**
 * BullMQ worker for outbound WhatsApp messages.
 *
 * Consumes OUTBOUND_MESSAGE jobs from the wa-message-outbound queue.
 * Calls Meta Graph API and updates the Message row via handleOutboundMessage.
 *
 * Key behavior:
 * - "uncertain" responses (timeout, 5xx, rate limit, parse errors) do NOT
 *   trigger a BullMQ retry — the message stays PENDING for operator review.
 * - "failed" responses (auth, validation errors) mark the message FAILED.
 * - Success updates the message to SENT.
 */

import type { Worker } from "bullmq";
import {
  JOB_TYPES,
  QUEUE_NAMES,
  createWorker,
  validateJobPayload,
  type OutboundMessageJobPayload,
} from "@/lib/queue";
import { handleOutboundMessage, type OutboundHandlerDependencies, type OutboundSendResult } from "./handler";

export function createOutboundMessageWorker(options?: {
  concurrency?: number;
  onFailed?: (jobId: string | undefined, error: Error) => void;
  dependencies?: OutboundHandlerDependencies;
}): Worker<OutboundMessageJobPayload, OutboundSendResult> {
  return createWorker<OutboundMessageJobPayload, OutboundSendResult>(
    QUEUE_NAMES.OUTBOUND_MESSAGE,
    async (job) => {
      const payload = validateJobPayload(job.data);
      if (payload.type !== JOB_TYPES.OUTBOUND_MESSAGE) {
        throw new Error(`Unsupported job type: ${payload.type}`);
      }
      return handleOutboundMessage(payload, options?.dependencies);
    },
    {
      concurrency: options?.concurrency,
      onFailed: (job, error) => options?.onFailed?.(job?.id, error),
    }
  );
}
