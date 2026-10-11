# ERA 2 — Durable WhatsApp Delivery Status Reconciliation

## Overview
Delivery status reconciliation for WhatsApp Cloud API events (sent, delivered, read, failed) is implemented as a durable asynchronous pipeline using:
- PostgreSQL for canonical state and event auditing.
- Transactional Outbox for atomic durability before ACK.
- BullMQ for asynchronous worker execution.
- Multi-tenant boundary verification on every operation.

The pipeline is disabled by default via feature flag `WHATSAPP_STATUS_ASYNC_ENABLED=false`.

## Architecture & Call Chains

### 1. Legacy Synchronous Path (Default)
When `WHATSAPP_STATUS_ASYNC_ENABLED` is false or unset:
```
Meta Webhook POST
  -> Signature Verification
  -> Create WebhookEvent (Audit)
  -> Sync processWebhook()
      -> handleStatus()
          -> Update Message status
          -> Publish Realtime WebSocket
```

### 2. Durable Asynchronous Path (Opt-in)
When `WHATSAPP_STATUS_ASYNC_ENABLED=true`:
```
Meta Webhook POST
  -> Signature Verification
  -> Classify payload (must be status-only, non-mixed)
  -> persistStatusWebhookReceipt() [ATOMIC TRANSACTION]
      -> Store WebhookEvent
      -> Resolve Tenant/WABA/Phone & Message ownership
      -> Insert OutboxEvent (type: status.reconciliation)
  -> HTTP 200 { received: true } to Meta

[Background Dispatcher & Worker]
OutboxDispatcher
  -> Claims PENDING OutboxEvents
  -> Publishes to BullMQ queue: wa-status-reconciliation
  -> Marks OutboxEvent PUBLISHED

BullMQ Worker (StatusReconciliationWorker)
  -> processStatusReconciliationJob()
      -> reconcileStatusEvent() [ATOMIC TRANSACTION]
          -> Verify tenant/WABA/phone ownership against persisted state
          -> Check status transition ranking (READ > DELIVERED > SENT)
          -> Prevent downgrading confirmed delivery states
          -> Update Message status & errorJson
          -> Update OutboundSendAttempt (state SENT or FAILED)
          -> Mark WebhookEvent processedOk = true
```

## Status Transition Matrix

| Current State | Incoming: SENT | Incoming: DELIVERED | Incoming: READ | Incoming: FAILED |
| :--- | :--- | :--- | :--- | :--- |
| **PENDING** | SENT | DELIVERED | READ | FAILED |
| **SENT** | SENT | DELIVERED | READ | FAILED |
| **DELIVERED** | DELIVERED (no downgrade) | DELIVERED | READ | DELIVERED (preserved) |
| **READ** | READ (no downgrade) | READ (no downgrade) | READ | READ (preserved) |
| **FAILED** | FAILED | DELIVERED | READ | FAILED |

## Correlation & Uncertainty Rules
1. **Authoritative Identification:** Correlation is performed exclusively via verified `waMessageId` (Meta provider ID) bound to the tenant's trusted phone number and conversation.
2. **No Invented IDs:** Recipient phone matching alone is forbidden.
3. **OutboundSendAttempt Reconciliation:**
   - Provider status resolves `PENDING`, `CLAIMED`, or `RETRYABLE` attempts to `SENT` or `FAILED`.
   - `UNCERTAIN` attempts require reliable correlation and are never automatically resent to Meta.
   - Status processing never triggers an outbound transmission.

## Testing & Verification
- Unit test for config: `npm run test test/lib/whatsapp/status/config.test.ts`
- Real PostgreSQL integration: `DATABASE_URL=... npx tsx test/integration/status-outbox.test.ts`
- Real BullMQ worker integration: `DATABASE_URL=... REDIS_URL=... npx tsx test/integration/status-worker.test.ts`
