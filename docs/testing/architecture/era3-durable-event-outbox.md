# ERA 3 durable canonical event outbox

Task: WA-ERA3-03.

## ERA 2 outbox inventory

ERA 2 outbox is `OutboxEvent` plus `src/lib/outbox/*`:

- `OutboxEvent.payload` stores validated BullMQ `KnownJobPayload` objects.
- `insertOutboxEvent` generates random UUID IDs and controls publication state (`PENDING`, `CLAIMED`, `PUBLISHED`, `RETRYABLE`, `TERMINAL`).
- `dispatchOutboxBatch` publishes to Redis/BullMQ and mutates publication state.

That storage is intentionally delivery-oriented and remains unchanged. It is not used for canonical external events because canonical events need producer-stable event IDs, complete `ExternalEvent` envelopes, idempotent duplicate inserts, and no delivery worker semantics in this task.

## Storage strategy

WA-ERA3-03 adds `CanonicalEventOutbox` only:

- primary key: canonical event `id` from WA-ERA3-02 producers;
- `tenantId` foreign key to `Tenant`;
- `eventType`, `contractVersion`, full validated JSON payload;
- `payloadHash` for conflict detection;
- `occurredAt`, `recordedAt`, `createdAt` for future bounded delivery scans.

The migration is additive and does not alter ERA 2 `OutboxEvent`.

## Repository guarantees

`src/lib/events/outbox.ts` validates the full `ExternalEvent` envelope before persistence. Insert semantics are:

- first insert creates the row;
- identical duplicate insert returns the existing row (`ON CONFLICT` + matching payload hash);
- same event ID with a different payload raises `CanonicalEventOutboxConflictError`;
- reads require `tenantId`, preventing cross-tenant lookup;
- bounded list queries require `tenantId` and cap `limit`.

PostgreSQL primary key enforces event identity uniqueness.

## Transaction boundaries

Canonical event persistence is called inside the same Prisma transaction as the authoritative transition when a safe boundary exists:

- outbound acceptance: `sendMessage` creates `Message`, creates ERA 2 queue outbox row, and stores `outbound.message.accepted` in one transaction;
- inbound receipt: inbound handler creates/updates `Conversation`, creates inbound `Message`, and stores `inbound.message.received` plus `conversation.changed` when applicable in one transaction;
- outbound status webhooks: status update and `outbound.message.status_changed` are one transaction;
- outbound worker success/failure: `Message`, `OutboundSendAttempt`, conversation update, and canonical status event are one transaction.

No-op transition helpers return `null`; callers do not persist an event in that case.

## Identity analysis

WA-ERA3-02 producer IDs remain unchanged. Stable IDs are safe for duplicate deliveries:

- inbound receipt: one event per local `Message.id`;
- outbound accepted: one event per local `Message.id`;
- outbound status changed: `messageId + previousStatus + status`, so repeated identical status delivery is idempotent while legitimate different transitions remain distinguishable;
- conversation changed: `conversationId + kind + status/NONE`, so no-op transitions produce no event.

A future business rule that needs multiple identical conversation status cycles as distinct external events would require changing the accepted producer identity contract and must be handled by a new approved task.

## Non-goals

This task adds no HTTP delivery, webhook destinations, retry worker, Redis delivery worker, dead-letter handling, WebSockets, UI, or consumer-specific adapter.
