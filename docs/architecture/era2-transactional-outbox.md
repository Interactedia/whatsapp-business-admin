# ERA 2 — Transactional Outbox Foundation

**Task ID:** WA-ERA2-05-DURABILITY  
**Status:** Implemented foundation, not production activation

## Architecture

PostgreSQL remains authoritative. Business code can insert an outbox row in the same Prisma transaction as its business mutation. Redis/BullMQ publication happens later through an explicitly started dispatcher.

No WhatsApp route, worker, webhook, status, broadcast, or frontend path is activated by this foundation.

## Data model

`OutboxEvent` stores:

- durable event id
- `tenantId` reference to `Tenant`
- queue event type and contract version
- validated minimal BullMQ payload/reference
- publication state: `PENDING`, `CLAIMED`, `PUBLISHED`, `RETRYABLE`, `TERMINAL`
- attempt count, max attempts, next eligible attempt
- claim owner and lease expiration
- publication timestamp
- sanitized failure code/message
- created/updated timestamps

Indexes cover pending/retry discovery, expired lease recovery, tenant-scoped inspection, and publication audit.

## Transaction API

Use `addOutboxEvent(tx, input)` inside an existing `prisma.$transaction(async (tx) => ...)` block. The API validates the typed job payload before writing and requires `input.tenantId` to match `payload.ref.tenantId`.

A transaction rollback rolls back the outbox insert. No Redis connection or network side effect is required to commit the business transaction.

## Dispatcher lifecycle

`dispatchOutboxBatch({ dispatcherId, batchSize, leaseMs })` claims and publishes one bounded batch. `OutboxDispatcher` provides explicit `start()` / `stop()` polling. Importing the module does not start queues, workers, Redis connections, signal handlers, or production processing.

Future native deployment can wrap an explicit dispatcher entrypoint in systemd. This task does not create or modify production units.

## Claiming and recovery

Claiming uses PostgreSQL `FOR UPDATE SKIP LOCKED` through Prisma raw SQL. Eligible rows are ordered by `nextAttemptAt`, `createdAt`, and `id`, then atomically moved to `CLAIMED` with `claimedBy` and `claimExpiresAt`.

Rows in `CLAIMED` with an expired lease are eligible for a later dispatcher claim. This supports crash recovery without deleting Redis keys manually.

## Publication guarantees

The dispatcher reuses `enqueueQueueJob`, preserving existing typed contracts, queue routing, validation, and BullMQ job identity behavior.

Guarantees are at-least-once publication only. A Redis enqueue followed by PostgreSQL acknowledgment failure can publish again after lease expiry. BullMQ `jobId` is not permanent business deduplication, and workers must remain idempotent.

## Retry behavior

Publication failure does not delete the event. The dispatcher increments attempts, records sanitized failure metadata, releases the claim, and schedules the next attempt. When `attemptCount >= maxAttempts`, the row becomes `TERMINAL` and remains inspectable.

## Tenant isolation

Outbox rows preserve tenant references and validated minimal payload references. `tenantId` is routing context, not authorization. Future business workers must refetch from PostgreSQL and reverify tenant/WABA/phone ownership before any side effect.

No public outbox endpoint or dashboard is added. Payload validation rejects sensitive key names such as tokens, secrets, passwords, credentials, authorization values, access tokens, and app secrets.

## Integration test commands

```bash
npx prisma migrate deploy
npm run test
DATABASE_URL=postgresql://... npx tsx test/integration/outbox-postgres.test.ts
DATABASE_URL=postgresql://... REDIS_URL=redis://127.0.0.1:6379 npx tsx test/integration/outbox-dispatch.test.ts
REDIS_URL=redis://127.0.0.1:6379 npx tsx test/integration/bullmq-producers.test.ts
npm run lint
npx tsc --noEmit
npm run build
```

Tests use unique tenant ids and BullMQ prefixes and clean their own outbox rows, tenants, and test queues.

## Native runtime assumptions

- Node.js 24
- PostgreSQL 16
- Redis 7
- BullMQ through existing native Redis configuration
- No Docker dependency

## Known limitations

- This foundation does not activate production WhatsApp processing.
- It does not implement business workers or Meta API calls.
- It does not provide FIFO or exactly-once guarantees.
- It does not replace future tenant authorization checks in consumers.
