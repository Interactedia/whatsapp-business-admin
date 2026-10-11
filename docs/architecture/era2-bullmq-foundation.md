# ERA 2 — BullMQ Infrastructure Foundation

**Task ID:** WA-ERA2-03-BULLMQ-INFRASTRUCTURE  
**Status:** Implemented  
**Date:** 2026-10-10  
**Scope:** Reusable BullMQ queue and worker infrastructure, explicit connection ownership, job contracts, operational inspection, safe shutdown, and native deployment guidance.

---

## 1. Implemented Architecture

The BullMQ infrastructure layer provides asynchronous execution facilities on top of the native Redis Foundation implemented in WA-ERA2-02.

### 1.1 Component Breakdown

| Module | Location | Responsibility |
|---|---|---|
| **Configuration** | `src/lib/queue/config.ts` | Centralized queue configuration, naming, prefixing, defaults, bounded retry options |
| **Contracts** | `src/lib/queue/contracts.ts` | Minimal reference-based job schemas and queue name constants |
| **Connection** | `src/lib/queue/connection.ts` | Isolated BullMQ connection options factory and dedicated connection tracking |
| **Queue Factory** | `src/lib/queue/factory.ts` | Explicit queue instantiation, registry, and cleanup |
| **Worker Factory** | `src/lib/queue/worker.ts` | Explicit worker initialization, error capture, concurrency, and shutdown |
| **Events** | `src/lib/queue/events.ts` | QueueEvents lifecycle management and registry |
| **Inspection** | `src/lib/queue/inspection.ts` | Non-destructive operational inspection of queue states and job counts |
| **Lifecycle** | `src/lib/queue/lifecycle.ts` | Coordinated shutdown of workers, events, queues, and dedicated connections |
| **Public API** | `src/lib/queue/index.ts` | Clean public exports for producers and workers |

### 1.2 Connection Ownership Strategy

BullMQ requires `maxRetriesPerRequest: null` for blocking operations (workers and event listeners). The existing application Redis singleton (`__waRedis` in `src/lib/redis/client.ts`) is configured with bounded retries (`maxRetriesPerRequest: 3`) and must **never** be shared with BullMQ.

To prevent connection contention, leaks, or double-shutdown:
1. **Managed Options Path (Default):** `getBullMQConnectionOptions()` provides connection parameters derived from `loadRedisConfig()`, forcing `maxRetriesPerRequest: null` and `enableReadyCheck: false`. BullMQ instantiates and manages its own internal `ioredis` instances.
2. **Dedicated Client Path:** When explicit `Redis` instances are required, `createBullMQConnection()` creates an `ioredis` client tracked in `trackedConnections` and closed via `closeConnection()` or `closeAllConnections()`.
3. **No Per-Request Connections:** Queues and Workers are registered once and kept in memory during the process lifetime.

---

## 2. Invariants & Safety

1. **PostgreSQL Authority:** PostgreSQL remains the canonical system of record. Queues carry job reference IDs, never full messages, customer PII, or media buffers.
2. **Import Safety:** Importing `@/lib/queue` performs zero network I/O and instantiates no queues or workers. The Next.js build succeeds without Redis running.
3. **No Automatic Worker Startup:** Workers only initialize when explicitly instantiated via `createWorker()`. No worker runs automatically in the Next.js API or App Router processes.
4. **Credential Redaction:** Redis credentials and connection strings never appear in error logs or metrics.
5. **Safe Idempotent Shutdown:** Calling `closeAllQueueResources()` multiple times is guaranteed safe and will not throw unhandled rejections.

---

## 3. Native Deployment & Worker Guidance

Consistent with ADR-0003 (Native deployment without Docker), queue processing in production is designed for native Linux execution.

### 3.1 Process Separation

- **Next.js Web / API Process:** Functions as a **producer only**. It imports `createQueue()` to enqueue jobs. It does **not** instantiate workers.
- **Standalone Node.js Worker Process:** A dedicated entry point (e.g., `src/workers/index.ts` in future tasks) instantiated via `node` or `tsx`. It imports `createWorker()` with business processors.

### 3.2 Standalone Worker Process Template

```ts
import { createWorker, closeAllQueueResources } from "@/lib/queue";

const worker = createWorker("wa-webhook-inbound", async (job) => {
  // Processor logic: re-fetch from PostgreSQL, verify tenant, process
  return { status: "processed" };
}, {
  concurrency: 5,
});

async function shutdown(signal: string) {
  console.info(`[worker] Received ${signal}, starting graceful shutdown...`);
  await closeAllQueueResources();
  console.info("[worker] All queue resources closed cleanly.");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
```

### 3.3 Systemd Service Boundary (Production)

Workers should be configured as standard systemd unit files on the host:
- Service type: `simple`
- Environment variables: `REDIS_URL=redis://127.0.0.1:6379`, `DATABASE_URL=...`
- Restart policy: `Restart=on-failure`, `RestartSec=5s`
- Graceful stop timeout: `TimeoutStopSec=30s` (allows in-flight jobs to complete)

---

## 4. Operational Inspection

Queue metrics are queried programmatically via `inspectQueue(queue)`:

```ts
import { createQueue, inspectQueue } from "@/lib/queue";

const queue = createQueue("wa-webhook-inbound");
const status = await inspectQueue(queue);

console.log(status);
// {
//   name: "wa-webhook-inbound",
//   isPaused: false,
//   counts: { waiting: 0, active: 1, completed: 42, failed: 0, delayed: 0, prioritized: 0, waitingChildren: 0 },
//   total: 43,
//   timestamp: "2026-10-10T23:00:00.000Z"
// }
```

---

## 5. Verification Evidence

### 5.1 Unit Tests (Offline / Mocked)
Executed via `npm run test`:
- `test/lib/queue/config.test.ts`: configuration, overrides, bounds, and error types.
- `test/lib/queue/connection.test.ts`: connection options, retry options, tracking, and shutdown.
- `test/lib/queue/factory.test.ts`: queue registration, lifecycle, and safe repeated cleanup.
- `test/lib/queue/worker.test.ts`: worker concurrency, error handling, failed jobs, and cleanup.
- `test/lib/queue/events.test.ts`: QueueEvents registration and shutdown.
- `test/lib/queue/inspection.test.ts`: job count inspection and paused status.
- `test/lib/queue/lifecycle.test.ts`: coordinated shutdown across all subsystems.
- `test/lib/queue/import-safety.test.ts`: verifying zero side effects on module import.

### 5.2 Real Redis Integration Test
Executed via:
```bash
REDIS_URL=redis://127.0.0.1:6379 npx tsx test/integration/bullmq-integration.test.ts
```
Verifies against real Redis 7.0.15:
- Queue initialization and QueueEvents readiness.
- Job enqueue with payload transfer.
- Worker processing and return value verification.
- Job state transitions (waiting → active → completed).
- Error capture and onFailed handler invocation for failing jobs.
- Safe worker and QueueEvents termination.
- Queue obliteration scoped strictly to test prefix (`wa-test-*`).
- Coordinated resource cleanup and idempotency.
