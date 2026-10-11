/**
 * Real Redis integration verification for BullMQ — WA-ERA2-03
 *
 * Run with:
 *   REDIS_URL=redis://127.0.0.1:6379 npx tsx test/integration/bullmq-integration.test.ts
 *
 * Verifies:
 *   A. Queue initialization
 *   B. Job enqueue
 *   C. Worker execution
 *   D. Job completion
 *   E. Job payload transfer
 *   F. Job failure reporting
 *   G. Job state inspection
 *   H. QueueEvents lifecycle and waiting for completion
 *   I. Worker shutdown
 *   J. Queue cleanup (isolated to test queue)
 *   K. Connection cleanup
 *   L. Bounded producer failure behavior
 */

const testRunId = `wa-test-${Date.now()}`;
const queueName = `test-int-queue-${Date.now()}`;

async function main() {
  process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  process.env.BULLMQ_PREFIX = testRunId;

  const {
    createQueue,
    createWorker,
    createQueueEvents,
    inspectQueue,
    closeQueue,
    closeWorker,
    closeQueueEvents,
    closeAllQueueResources,
    getBullMQConnectionOptions,
  } = await import("@/lib/queue");

  const results: { label: string; ok: boolean; detail?: string }[] = [];

  async function check(label: string, ok: boolean, detail?: string) {
    results.push({ label, ok, detail });
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
  }

  console.log(`Starting BullMQ Integration Verification against ${process.env.REDIS_URL}`);
  console.log(`Test queue: "${queueName}", prefix: "${testRunId}"\n`);

  let queue: ReturnType<typeof createQueue> | null = null;
  let worker: ReturnType<typeof createWorker> | null = null;
  let queueEvents: ReturnType<typeof createQueueEvents> | null = null;

  try {
    // === A. Queue initialization ===
    queue = createQueue(queueName);
    await check("A. Queue initialization succeeds", queue !== null && queue.name === queueName);

    // === H (part 1). QueueEvents initialization ===
    queueEvents = createQueueEvents(queueName);
    await queueEvents.waitUntilReady();
    await check("H. QueueEvents initialized and ready", true);

    // === B & E. Job enqueue with typed payload ===
    const testPayload = {
      version: 1,
      tenantId: "tenant-test-123",
      enqueuedAt: new Date().toISOString(),
      action: "test-roundtrip",
    };

    const job1 = await queue.add("test-job-1", testPayload);
    await check("B. Job enqueue succeeds with generated ID", Boolean(job1.id), `Job ID: ${job1.id}`);

    // === G. Job state inspection (waiting) ===
    let inspection = await inspectQueue(queue);
    await check(
      "G. Job state inspection reflects waiting job",
      inspection.counts.waiting >= 1,
      `waiting=${inspection.counts.waiting}, total=${inspection.total}`
    );

    // === C & D & E. Worker execution, payload transfer, and completion ===
    let receivedPayload: unknown = null;
    let workerExecuted = false;

    worker = createWorker(
      queueName,
      async (job) => {
        workerExecuted = true;
        receivedPayload = job.data;
        return { processed: true, echoTenant: job.data.tenantId };
      },
      { concurrency: 1 }
    );

    // Wait for job completion via QueueEvents
    const completedJobResult = await job1.waitUntilFinished(queueEvents, 10000);

    await check("C. Worker execution triggers", workerExecuted === true);
    await check(
      "E. Job payload transfer is intact",
      JSON.stringify(receivedPayload) === JSON.stringify(testPayload),
      `tenantId: ${(receivedPayload as { tenantId?: string })?.tenantId}`
    );
    await check(
      "D. Job completion verified with return value",
      completedJobResult?.processed === true && completedJobResult?.echoTenant === "tenant-test-123",
      JSON.stringify(completedJobResult)
    );

    // === G (part 2). Job state inspection after completion ===
    inspection = await inspectQueue(queue);
    await check(
      "G. Job state inspection reflects completed job",
      inspection.counts.completed >= 1,
      `completed=${inspection.counts.completed}`
    );

    // === F. Job failure reporting ===
    let failReported = false;
    let failErrorMessage = "";

    // Close first worker to register a worker that intentionally throws
    await closeWorker(worker);

    const failingWorker = createWorker(
      queueName,
      async () => {
        throw new Error("Intentional test processing failure");
      },
      {
        concurrency: 1,
        onFailed: (_job, err) => {
          failReported = true;
          failErrorMessage = err.message;
        },
      }
    );

    const job2 = await queue.add("test-failing-job", { willFail: true }, { attempts: 1 });

    try {
      await job2.waitUntilFinished(queueEvents, 10000);
    } catch {
      // Expected to reject
    }

    await check(
      "F. Job failure reported through onFailed handler",
      failReported === true && failErrorMessage.includes("Intentional test processing failure"),
      failErrorMessage
    );

    inspection = await inspectQueue(queue);
    await check(
      "G. Job state inspection reflects failed job",
      inspection.counts.failed >= 1,
      `failed=${inspection.counts.failed}`
    );

    // === I. Worker shutdown ===
    await closeWorker(failingWorker);
    await check("I. Worker shutdown succeeds without hanging", true);

    // === H (part 2). QueueEvents shutdown ===
    await closeQueueEvents(queueEvents);
    queueEvents = null;
    await check("H. QueueEvents shutdown succeeds", true);

    // === J. Queue cleanup (isolated to test queue) ===
    await queue.obliterate({ force: true });
    inspection = await inspectQueue(queue);
    await check(
      "J. Queue cleanup via obliterate empties test queue",
      inspection.total === 0,
      `total remaining: ${inspection.total}`
    );

    await closeQueue(queue);
    queue = null;
    await check("J. Queue close succeeds and unregisters", true);

    // === K. Connection cleanup and repeated shutdown ===
    await closeAllQueueResources();
    await check("K. Coordinated resource cleanup succeeds", true);

    // Repeated call must be safe
    await closeAllQueueResources();
    await check("K. Repeated coordinated cleanup is safe and idempotent", true);

    // === L. Bounded producer failure behavior without Redis ===
    const originalUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      getBullMQConnectionOptions();
      await check("L. Bounded failure when Redis not configured", false, "Did not throw");
    } catch (err) {
      const errMsg = (err as Error).message;
      await check(
        "L. Bounded failure when Redis not configured",
        errMsg.includes("REDIS_URL must be set"),
        errMsg
      );
    } finally {
      process.env.REDIS_URL = originalUrl;
    }
  } catch (unexpected) {
    console.error("Unexpected error in integration suite:", unexpected);
    await check("Suite completed without unhandled exceptions", false, (unexpected as Error).message);
  } finally {
    // Ensure all remaining resources are cleaned up
    if (queueEvents) await closeQueueEvents(queueEvents).catch(() => {});
    if (queue) await closeQueue(queue).catch(() => {});
    await closeAllQueueResources().catch(() => {});
  }

  console.log("\n--- Integration Test Summary ---");
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(`Total checks: ${total}, Passed: ${passed}, Failed: ${total - passed}`);

  if (passed !== total) {
    console.error("FAIL: Not all integration checks passed.");
    process.exit(1);
  }

  console.log("PASS: Real Redis BullMQ integration verified successfully.");
}

main().catch((err) => {
  console.error("Fatal integration test error:", err);
  process.exit(1);
});
