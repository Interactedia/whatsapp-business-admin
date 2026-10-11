/**
 * Coordinated lifecycle management for BullMQ resources.
 *
 * Provides safe shutdown for standalone workers or graceful process termination.
 *
 * Invariants:
 * - Workers shut down first to stop pulling jobs.
 * - Queues and events shut down next.
 * - Dedicated connections shut down last.
 * - Repeated shutdown is safe and idempotent.
 */

import { closeAllWorkers } from "./worker";
import { closeAllQueues } from "./factory";
import { closeAllQueueEvents } from "./events";
import { closeAllConnections } from "./connection";

/**
 * Cleanly closes all tracked BullMQ resources.
 * Order of operations:
 * 1. Workers (pause and complete in-flight tasks)
 * 2. QueueEvents
 * 3. Queues
 * 4. Explicitly managed dedicated connections
 *
 * Safe to call repeatedly.
 */
export async function closeAllQueueResources(): Promise<void> {
  await closeAllWorkers();
  await closeAllQueueEvents();
  await closeAllQueues();
  await closeAllConnections();
}
