import type { JobsOptions, Queue } from "bullmq";
import { createQueue, closeQueue } from "./factory";
import type { KnownJobPayload } from "./contracts";
import { buildJobIdentityForPayload, getJobContract, JobValidationError, validateJobPayload } from "./jobs/validation";

export type ProducerErrorCode =
  | "INVALID_PAYLOAD"
  | "UNSUPPORTED_VERSION"
  | "MISSING_CONFIGURATION"
  | "QUEUE_UNAVAILABLE"
  | "ENQUEUE_FAILURE";

export class QueueProducerError extends Error {
  constructor(
    public readonly code: ProducerErrorCode,
    message: string,
    public readonly details: string[] = [],
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "QueueProducerError";
  }
}

export interface EnqueueJobOptions {
  queue?: Queue<KnownJobPayload>;
  jobOptions?: JobsOptions;
  closeQueueAfterEnqueue?: boolean;
}

export interface EnqueueJobResult {
  ok: true;
  queueName: string;
  jobName: string;
  jobId: string;
  bullmqJobId: string | undefined;
  payload: KnownJobPayload;
}

export async function enqueueQueueJob(
  rawPayload: unknown,
  options: EnqueueJobOptions = {}
): Promise<EnqueueJobResult> {
  let payload: KnownJobPayload;
  try {
    payload = validateJobPayload(rawPayload);
  } catch (error) {
    if (error instanceof JobValidationError) {
      throw new QueueProducerError(
        error.code === "UNSUPPORTED_VERSION" ? "UNSUPPORTED_VERSION" : "INVALID_PAYLOAD",
        error.message,
        error.details,
        error
      );
    }
    throw error;
  }

  const contract = getJobContract(payload);
  const identity = buildJobIdentityForPayload(payload);
  let ownedQueue: Queue<KnownJobPayload> | undefined;
  const queue = options.queue ?? (ownedQueue = createQueue<KnownJobPayload>(contract.queueName));

  try {
    const job = await queue.add(contract.jobName, payload, {
      jobId: identity.jobId,
      ...options.jobOptions,
    });

    return {
      ok: true,
      queueName: contract.queueName,
      jobName: contract.jobName,
      jobId: identity.jobId,
      bullmqJobId: job.id,
      payload,
    };
  } catch (error) {
    throw new QueueProducerError("ENQUEUE_FAILURE", "Failed to enqueue queue job", safeDetails(error), error);
  } finally {
    if (ownedQueue && options.closeQueueAfterEnqueue) {
      await closeQueue(ownedQueue);
    }
  }
}

function safeDetails(error: unknown): string[] {
  if (error instanceof Error) return [error.message.replace(/redis:\/\/[^@\s]+@/gi, "redis://[redacted]@")];
  return [];
}
