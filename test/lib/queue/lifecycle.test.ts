import { describe, expect, it, vi, beforeEach } from "vitest";
import { closeAllQueueResources } from "@/lib/queue/lifecycle";

const _closeWorkers = vi.fn().mockResolvedValue(undefined);
const _closeEvents = vi.fn().mockResolvedValue(undefined);
const _closeQueues = vi.fn().mockResolvedValue(undefined);
const _closeConnections = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/queue/worker", () => ({
  closeAllWorkers: () => _closeWorkers(),
}));

vi.mock("@/lib/queue/events", () => ({
  closeAllQueueEvents: () => _closeEvents(),
}));

vi.mock("@/lib/queue/factory", () => ({
  closeAllQueues: () => _closeQueues(),
}));

vi.mock("@/lib/queue/connection", () => ({
  closeAllConnections: () => _closeConnections(),
}));

describe("Queue coordinated lifecycle", () => {
  beforeEach(() => {
    _closeWorkers.mockClear();
    _closeEvents.mockClear();
    _closeQueues.mockClear();
    _closeConnections.mockClear();
  });

  it("closeAllQueueResources coordinates shutdown across all subsystems", async () => {
    await closeAllQueueResources();

    expect(_closeWorkers).toHaveBeenCalledTimes(1);
    expect(_closeEvents).toHaveBeenCalledTimes(1);
    expect(_closeQueues).toHaveBeenCalledTimes(1);
    expect(_closeConnections).toHaveBeenCalledTimes(1);
  });

  it("repeated closeAllQueueResources is safe", async () => {
    await closeAllQueueResources();
    await closeAllQueueResources();

    expect(_closeWorkers).toHaveBeenCalledTimes(2);
    expect(_closeEvents).toHaveBeenCalledTimes(2);
    expect(_closeQueues).toHaveBeenCalledTimes(2);
    expect(_closeConnections).toHaveBeenCalledTimes(2);
  });
});
