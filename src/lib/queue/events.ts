/**
 * BullMQ QueueEvents factory and lifecycle management.
 *
 * Invariants:
 * - Centralized registry for safe shutdown.
 * - Safe repeated cleanup.
 */

import { QueueEvents, type QueueEventsOptions } from "bullmq";
import { getBullMQConnectionOptions } from "./connection";
import { getQueueConfig } from "./config";

export interface CreateQueueEventsOptions
  extends Partial<Omit<QueueEventsOptions, "connection">> {
  connection?: QueueEventsOptions["connection"];
}

const eventsRegistry = new Set<QueueEvents>();

/**
 * Creates and registers a BullMQ QueueEvents instance.
 */
export function createQueueEvents(
  name: string,
  options?: CreateQueueEventsOptions
): QueueEvents {
  const config = getQueueConfig();
  const connection = options?.connection ?? getBullMQConnectionOptions();

  const events = new QueueEvents(name, {
    prefix: config.prefix,
    ...options,
    connection,
  });

  events.on("error", (err) => {
    console.error(
      `[bullmq-events] error in QueueEvents for queue "${name}": ${err.message}`
    );
  });

  eventsRegistry.add(events);
  return events;
}

/**
 * Closes an individual QueueEvents instance and removes it from the registry.
 */
export async function closeQueueEvents(events: QueueEvents): Promise<void> {
  try {
    await events.close();
  } finally {
    eventsRegistry.delete(events);
  }
}

/**
 * Closes all registered QueueEvents instances. Safe to call repeatedly.
 */
export async function closeAllQueueEvents(): Promise<void> {
  const allEvents = Array.from(eventsRegistry);
  eventsRegistry.clear();
  await Promise.all(
    allEvents.map(async (e) => {
      try {
        await e.close();
      } catch (err) {
        console.error(
          `[bullmq] error closing QueueEvents for queue "${e.name}": ${(err as Error).message}`
        );
      }
    })
  );
}

/**
 * Returns the count of registered QueueEvents instances.
 */
export function getEventsRegistrySize(): number {
  return eventsRegistry.size;
}
