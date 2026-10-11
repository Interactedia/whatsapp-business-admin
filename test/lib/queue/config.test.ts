import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  getQueueConfig,
  QUEUE_NAMES,
  DEFAULT_JOB_OPTIONS,
  QueueConfigurationError,
} from "@/lib/queue/config";

describe("Queue configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns default configuration values", () => {
    delete process.env.BULLMQ_PREFIX;
    delete process.env.BULLMQ_WORKER_CONCURRENCY;

    const config = getQueueConfig();
    expect(config.prefix).toBe("wa-queue");
    expect(config.defaultWorkerConcurrency).toBe(5);
    expect(config.defaultJobOptions).toEqual(DEFAULT_JOB_OPTIONS);
  });

  it("respects BULLMQ_PREFIX override", () => {
    process.env.BULLMQ_PREFIX = "custom-prefix";
    const config = getQueueConfig();
    expect(config.prefix).toBe("custom-prefix");
  });

  it("respects BULLMQ_WORKER_CONCURRENCY override", () => {
    process.env.BULLMQ_WORKER_CONCURRENCY = "10";
    const config = getQueueConfig();
    expect(config.defaultWorkerConcurrency).toBe(10);
  });

  it("clamps BULLMQ_WORKER_CONCURRENCY to minimum of 1", () => {
    process.env.BULLMQ_WORKER_CONCURRENCY = "0";
    const config = getQueueConfig();
    expect(config.defaultWorkerConcurrency).toBe(1);

    process.env.BULLMQ_WORKER_CONCURRENCY = "-5";
    expect(getQueueConfig().defaultWorkerConcurrency).toBe(1);
  });

  it("defines standard queue names", () => {
    expect(QUEUE_NAMES.INBOUND_WEBHOOK).toBe("wa-webhook-inbound");
    expect(QUEUE_NAMES.OUTBOUND_MESSAGE).toBe("wa-message-outbound");
    expect(QUEUE_NAMES.STATUS_RECONCILIATION).toBe("wa-status-reconciliation");
    expect(QUEUE_NAMES.BROADCAST_DISPATCH).toBe("wa-broadcast-dispatch");
  });

  it("defines bounded default job options", () => {
    expect(DEFAULT_JOB_OPTIONS.attempts).toBe(3);
    expect(DEFAULT_JOB_OPTIONS.backoff.type).toBe("exponential");
    expect(DEFAULT_JOB_OPTIONS.backoff.delay).toBe(1000);
    expect(DEFAULT_JOB_OPTIONS.removeOnComplete.count).toBe(1000);
    expect(DEFAULT_JOB_OPTIONS.removeOnFail.count).toBe(5000);
  });

  it("QueueConfigurationError creates error with correct name", () => {
    const err = new QueueConfigurationError("test message");
    expect(err.name).toBe("QueueConfigurationError");
    expect(err.message).toBe("test message");
  });
});
