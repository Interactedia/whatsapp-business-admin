# ERA 2 Queue and Outbox Observability

WA-ERA2-12 adds a read-only system administrator view for operational queue and outbox health.

## Available metrics

- BullMQ queue counts for existing queues: `waiting`, `active`, `delayed`, `completed`, `failed`, plus pause status when available.
- PostgreSQL OutboxEvent counts: `pending`, `claimed`, `retryable`, `published`, `terminal`, expired leases, oldest pending age.
- OutboundSendAttempt counts by state, including `UNCERTAIN`.

## What metrics mean

- Queue counts are Redis/BullMQ execution signals.
- Outbox counts are PostgreSQL publication-state aggregates.
- Outbound attempt counts describe Meta send attempt outcomes recorded in PostgreSQL.

## What metrics do not establish

- BullMQ `completed` does not mean Meta delivered a message.
- Outbox `published` does not mean Meta delivered a message.
- `UNCERTAIN` is not `FAILED` and is not safe to retry automatically.

## Authorization scope

The API route `/api/admin/queue-observability` and UI route `/admin/queue-observability` require `SYSTEM_ADMIN`.
Tenant `ADMIN` users cannot access global queue or outbox observability.
Tenant-scoped queue metrics are intentionally not exposed because BullMQ aggregate counts cannot be safely filtered by tenant without scanning jobs.

## Error behavior

Redis and PostgreSQL are collected independently:

- Redis unavailable: queue metrics are marked unavailable; PostgreSQL metrics can still be returned.
- PostgreSQL unavailable: database metrics are marked unavailable; queue metrics can still be returned.
- Unavailable measurements are not reported as zero.

Errors are sanitized to error class/name only; credentials, secrets, message bodies, and job payloads are not returned.

## Limitations

- No polling daemon, alerting, tracing, replay, retry, queue deletion, or repair controls are included.
- The UI is a compact current-state view, not historical analytics.
- Queries are aggregate-only and do not enumerate job payloads or customer message content.

## Validation commands

```bash
npm run test
npm run lint
npx tsc --noEmit
npm run build
npx prisma validate
REDIS_URL=redis://127.0.0.1:6379 npx tsx test/integration/bullmq-integration.test.ts
DATABASE_URL=postgresql://... npx tsx test/integration/outbox-postgres.test.ts
DATABASE_URL=postgresql://... npx tsx test/integration/outbound-attempt-postgres.test.ts
```
