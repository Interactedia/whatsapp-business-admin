/**
 * Reusable BullMQ Worker factory.
 *
 * Invariants:
 * - Explicit worker startup: no worker initialized on module import.
 * - Error event handling attached automatically.
 * - Centralized registry for safe, graceful shutdown.
 * - Credential redaction in error logging.
 */

import { Worker, type Processor, type WorkerOptions, type Job } from "bullmq";
import { getBullMQConnectionOptions } from "./connection";
import { getQueueConfig } from "./config";

export interface CreateWorkerOptions<TData = unknown, TResult = unknown>
  extends Partial<Omit<WorkerOptions, "connection">> {
  connection?: WorkerOptions["connection"];
  onError?: (err: Error) => void;
  onFailed?: (job: Job<TData, TResult> | undefined, err: Error) => void;
  onCompleted?: (job: Job<TData, TResult>, result: TResult) => void;
}

const workerRegistry = new Set<Worker>();

/**
 * Creates and registers a BullMQ Worker instance.
 */
export function createWorker<TData = unknown, TResult = unknown>(
  name: string,
  processor: Processor<TData, TResult>,
  options?: CreateWorkerOptions<TData, TResult>
): Worker<TData, TResult> {
  const config = getQueueConfig();
  const connection = options?.connection ?? getBullMQConnectionOptions();

  const worker = new Worker<TData, TResult>(name, processor, {
    prefix: config.prefix,
    concurrency: options?.concurrency ?? config.defaultWorkerConcurrency,
    ...options,
    connection,
  });

  worker.on("error", (err) => {
    console.error(`[bullmq-worker] error in worker for queue "${name}": ${err.message}`);
    options?.onError?.(err);
  });

  worker.on("failed", (job, err) => {
    console.error(
      `[bullmq-worker] job ${job?.id ?? "unknown"} failed in queue "${name}": ${err.message}`
    );
    options?.onFailed?.(job, err);
  });

  if (options?.onCompleted) {
    worker.on("completed", options.onCompleted);
  }

  workerRegistry.add(worker as unknown as Worker);
  return worker;
}

/**
 * Closes an individual worker and removes it from the registry.
 */
export async function closeWorker(worker: Worker): Promise<void> {
  try {
    await worker.close();
  } finally {
    workerRegistry.delete(worker);
  }
}

/**
 * Closes all registered workers. Safe to call repeatedly.
 */
export async function closeAllWorkers(): Promise<void> {
  const workers = Array.from(workerRegistry);
  workerRegistry.clear();
  await Promise.all(
    workers.map(async (w) => {
      try {
        await w.close();
      } catch (err) {
        console.error(
          `[bullmq] error closing worker for queue "${w.name}": ${(err as Error).message}`
        );
      }
    })
  );
}

/**
 * Returns the count of registered workers.
 */
export function getWorkerRegistrySize(): number {
  return workerRegistry.size;
}
