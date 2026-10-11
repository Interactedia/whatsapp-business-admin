/**
 * Reusable BullMQ Queue factory.
 *
 * Invariants:
 * - Explicit initialization: no queues created on module import.
 * - Centralized registry for safe, coordinated shutdown.
 * - Safe repeated cleanup.
 */

import { Queue, type QueueOptions } from "bullmq";
import { getBullMQConnectionOptions } from "./connection";
import { getQueueConfig } from "./config";

export interface CreateQueueOptions extends Partial<Omit<QueueOptions, "connection">> {
  connection?: QueueOptions["connection"];
}

const queueRegistry = new Map<string, Queue>();

/**
 * Creates and registers a BullMQ Queue instance.
 */
export function createQueue<TData = unknown, TResult = unknown>(
  name: string,
  options?: CreateQueueOptions
): Queue<TData, TResult> {
  const config = getQueueConfig();
  const connection = options?.connection ?? getBullMQConnectionOptions();

  const queue = new Queue<TData, TResult>(name, {
    prefix: config.prefix,
    defaultJobOptions: config.defaultJobOptions,
    ...options,
    connection,
  });

  queueRegistry.set(name, queue as unknown as Queue);
  return queue;
}

/**
 * Returns a registered queue instance by name, if it exists.
 */
export function getRegisteredQueue(name: string): Queue | undefined {
  return queueRegistry.get(name);
}

/**
 * Closes an individual queue and removes it from the registry.
 */
export async function closeQueue(queue: Queue): Promise<void> {
  const name = queue.name;
  try {
    await queue.close();
  } finally {
    queueRegistry.delete(name);
  }
}

/**
 * Closes all registered queue instances. Safe to call repeatedly.
 */
export async function closeAllQueues(): Promise<void> {
  const queues = Array.from(queueRegistry.values());
  queueRegistry.clear();
  await Promise.all(
    queues.map(async (q) => {
      try {
        await q.close();
      } catch (err) {
        console.error(
          `[bullmq] error closing queue "${q.name}": ${(err as Error).message}`
        );
      }
    })
  );
}

/**
 * Returns the count of registered queue instances.
 */
export function getQueueRegistrySize(): number {
  return queueRegistry.size;
}
