# ADR-0005 — Durable background processing

- Status: **Proposed — do not implement without approval**
- Date: 2026-10-09

## Context

The supplied report identifies in-process `p-queue` for broadcasts and a single webhook processing attempt. Process restart and retry behavior are not sufficiently evidenced.

## Proposal

Adopt natively installed Redis with BullMQ for jobs needing durable retry/concurrency control: outbound sends, broadcasts, event relays, and possibly media processing. Keep PostgreSQL as canonical persistence. For DB event -> queue publication, prefer a transactional outbox (DB state+outbox inserted in one transaction, publisher retries) to close the dual-write failure window. Include dedupe/idempotency keys, capped exponential retries, dead-letter/failure inspection, retention policy, rate limits and graceful shutdown. Review whether selected job classes need strict per-phone ordering and how Meta throughput/errors are honored. Do not equate Redis Pub/Sub with persistence. Select Redis persistence and host restart behavior explicitly.

## Tradeoffs

Additional daemon and operational complexity versus restart survival and controlled delivery. Alternative: PostgreSQL-backed job queue to minimize services. Compare before approval. Benchmark workloads and verify exact versions before implementation.

## Acceptance gate

Demonstrate crash/restart, duplicate event, timeout, rate limit, poison job and DB/Redis outage behaviors; prove no acknowledged work is silently lost; document at-least-once semantics, audit, native systemd units, and migration path away from in-process broadcasting.
