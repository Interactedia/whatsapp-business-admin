import { describe, expect, it } from "vitest";

describe("Queue import safety", () => {
  it("importing @/lib/queue executes no network calls and instantiates no resources", async () => {
    // Delete REDIS_URL to prove importing works in environments without Redis
    const originalEnv = process.env.REDIS_URL;
    delete process.env.REDIS_URL;

    try {
      const queueModule = await import("@/lib/queue");

      // Module exports should be defined functions and constants
      expect(typeof queueModule.createQueue).toBe("function");
      expect(typeof queueModule.createWorker).toBe("function");
      expect(typeof queueModule.createQueueEvents).toBe("function");
      expect(typeof queueModule.inspectQueue).toBe("function");
      expect(typeof queueModule.closeAllQueueResources).toBe("function");
      expect(queueModule.QUEUE_NAMES).toBeDefined();

      // Registries must be empty
      expect(queueModule.getQueueRegistrySize()).toBe(0);
      expect(queueModule.getWorkerRegistrySize()).toBe(0);
      expect(queueModule.getEventsRegistrySize()).toBe(0);
      expect(queueModule.getTrackedConnectionsCount()).toBe(0);
    } finally {
      if (originalEnv) {
        process.env.REDIS_URL = originalEnv;
      }
    }
  });
});
