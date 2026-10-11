# ERA 2 — Durable Broadcast Queue Migration

## 1. Context and Objective

The broadcast execution pipeline previously ran within a single in-process queue (`PQueue`) in the Next.js API process. This had several operational limitations:
- A worker/process crash during fan-out lost in-flight dispatch state.
- Retrying a failed campaign could easily duplicate sends to contacts who already received the message.
- Provider rate limits could not be coordinated across horizontally scaled application instances.
- Meta timeouts or ambiguous 5xx responses had no durable `UNCERTAIN` state protection.

This migration transitions broadcast execution to PostgreSQL Transactional Outbox and Redis/BullMQ while preserving existing campaign semantics, recipient idempotency, tenant isolation, and cancellation behavior.

---

## 2. Call Chains

### 2.1 Legacy Call Chain (`WHATSAPP_BROADCAST_ASYNC_ENABLED=false`)

```
POST /api/broadcasts or POST /api/v1/broadcasts
  └── runBroadcast(broadcastId)
        └── runLegacyBroadcast(broadcastId)
              ├── prisma.broadcast.update({ status: 'RUNNING' })
              └── PQueue({ concurrency: 8, interval: 1000, intervalCap: 20 })
                    └── for each recipient:
                          └── sendMessage(...) [direct Meta API call]
                          └── update recipient & broadcast counters
```

### 2.2 New Durable Call Chain (`WHATSAPP_BROADCAST_ASYNC_ENABLED=true`)

```
POST /api/broadcasts or POST /api/v1/broadcasts
  └── runBroadcast(broadcastId)
        └── dispatchBroadcast(broadcastId)
              ├── Revalidate tenant & approved template
              └── PostgreSQL Transaction:
                    ├── prisma.broadcast.update({ status: 'RUNNING' })
                    └── For each eligible PENDING recipient:
                          └── addOutboxEvent(tx, {
                                type: 'broadcast.dispatch',
                                payload: { tenantId, wabaAccountId, broadcastId, broadcastRecipientId, contactId }
                              })
```

```
OutboxDispatcher
  └── claims OutboxEvent batch
        └── enqueueQueueJob(payload) → BullMQ queue "wa-broadcast-dispatch"
              └── marks OutboxEvent PUBLISHED
```

```
createBroadcastDispatchWorker() (BullMQ Worker)
  └── handleBroadcastDispatch(job.data)
        ├── 1. Revalidate campaign & tenant ownership
        ├── 2. Check campaign cancellation (aborts if CANCELLED)
        ├── 3. Check recipient terminal status (ALREADY_SENT / ALREADY_FAILED)
        ├── 4. Atomic claim: claimBroadcastRecipient(...)
        │       ├── Links unique Message to BroadcastRecipient
        │       └── Claims OutboundSendAttempt (state: CLAIMED)
        ├── 5. Mark metaRequestStartedAt (prevents duplicate sends on crash/timeout)
        ├── 6. graphFetch(Meta API)
        └── 7. Outcome reconciliation:
                ├── 200 OK:
                │     ├── OutboundSendAttempt → SENT
                │     ├── Message → SENT (waMessageId recorded)
                │     ├── BroadcastRecipient → SENT (waMessageId recorded)
                │     ├── Broadcast.sentCount incremented (+1)
                │     └── maybeCompleteBroadcast()
                ├── 4xx (Client/Auth error):
                │     ├── OutboundSendAttempt → FAILED
                │     ├── Message → FAILED
                │     ├── BroadcastRecipient → FAILED (error recorded)
                │     ├── Broadcast.failedCount incremented (+1)
                │     └── maybeCompleteBroadcast()
                └── 5xx / 429 / Timeout (Ambiguous):
                      ├── OutboundSendAttempt → UNCERTAIN (non-retryable)
                      ├── Message stays PENDING (errorJson.uncertain = true)
                      ├── BroadcastRecipient stays PENDING (error: "UNCERTAIN: ...")
                      └── No counters incremented; BullMQ job finishes without blind retry
```

---

## 3. Feature Flag

The feature flag is defined in `src/lib/whatsapp/broadcast/config.ts`:

- Variable: `WHATSAPP_BROADCAST_ASYNC_ENABLED`
- Default: `false`
- Behavior when `false`: Preserves `runLegacyBroadcast` (in-process PQueue).
- Behavior when `true`: Uses `dispatchBroadcast` (Transactional Outbox + BullMQ worker).
- **Production Safety:** This flag is disabled by default in production and must never implicitly enable `WHATSAPP_OUTBOUND_ASYNC_ENABLED`.

---

## 4. Recipient Identity and Idempotency Boundaries

1. **Database Identity:**
   - Every `BroadcastRecipient` row has an immutable `id` (cuid) and a database constraint `@@unique([broadcastId, contactId])`.
   - Additive persistence: `BroadcastRecipient.messageId` links 1:1 with `Message.id` (`@unique`).
2. **Outbox Idempotency:**
   - `dispatchBroadcast` queries existing `OutboxEvent` records for `broadcastId` to ensure repeated dispatch calls never insert duplicate outbox events for the same recipient.
3. **BullMQ Job Deduplication:**
   - BullMQ `jobId` is constructed deterministically:
     `broadcast.dispatch.v1.${tenantId}.${wabaAccountId}.broadcastRecipient.${broadcastRecipientId}`.
4. **Execution Ownership (PostgreSQL Level):**
   - Relying on BullMQ job IDs alone is insufficient. Execution ownership is enforced atomically in PostgreSQL:
     - Worker calls `claimBroadcastRecipient()`, which creates or reuses the `Message` and calls `claimOutboundAttempt()` on `OutboundSendAttempt`.
     - Concurrent workers or BullMQ replays find the recipient already in `CLAIMED`, `SENT`, `FAILED`, or `UNCERTAIN` state and skip immediately.

---

## 5. Campaign Cancellation

- Function: `cancelBroadcast(db, broadcastId, tenantId)`.
- Transitions `Broadcast.status` to `CANCELLED`.
- Dispatch stage: `dispatchBroadcast` throws if the campaign is already cancelled.
- Worker stage: Before executing any recipient send, `handleBroadcastDispatch` checks `broadcast.status`. If `CANCELLED`, the send is aborted cleanly without contacting Meta.
- In-flight safety: Once `metaRequestStartedAt` is timestamped, the request has crossed the provider boundary and cannot be retracted.

---

## 6. Rate Limiting and Backpressure

- BullMQ worker rate limiter:
  ```ts
  limiter: {
    max: 20,
    duration: 1000,
  }
  ```
  Matches Meta's per-second rate limits and the existing 20 req/s ceiling.
- Concurrency: Defaults to 5 (bounded concurrency) to prevent starving real-time messaging or exhausting database connection pools.
- Backpressure: Outbox batching dispatches events in configurable batches (default 50), preventing massive unconstrained Redis enqueue bursts.

---

## 7. Campaign Progress Semantics

- Authoritative state resides in PostgreSQL, never in Redis queue counters.
- `sentCount` increments ONLY when Meta confirms delivery acceptance with a valid `waMessageId`.
- `failedCount` increments ONLY on deterministic 4xx client/auth failures.
- `UNCERTAIN` outcomes leave the recipient in `PENDING` with an annotated error and do not increment counters.
- Completion transition: `maybeCompleteBroadcast()` transitions `Broadcast.status` to `COMPLETED` only when 0 `PENDING` recipients remain and the campaign is currently `RUNNING`.

---

## 8. Recovery and Failure Modes

1. **PostgreSQL Interruption:**
   - `dispatchBroadcast` runs in a single transaction. If PostgreSQL fails, neither the `RUNNING` status nor outbox events are committed.
2. **Redis Outage:**
   - Outbox events remain durably persisted in PostgreSQL. When `dispatchOutboxBatch` fails to publish to Redis, events transition to `RETRYABLE` and recover when Redis returns.
3. **Worker Crash:**
   - If the worker crashes before `metaRequestStartedAt`, the `OutboundSendAttempt` lease expires after 60s and can be safely reclaimed.
   - If the worker crashes after `metaRequestStartedAt`, the attempt remains guarded so it cannot cause duplicate Meta sends.
4. **Meta 5xx / Timeout:**
   - Attempt transitions to `UNCERTAIN`. BullMQ does not retry, protecting against duplicate customer sends.

---

## 9. Tenant Isolation

- Workers do not trust queue payload fields blindly.
- Persisted database rows are re-checked at every step:
  - `broadcast.tenantId === job.ref.tenantId`
  - `broadcast.template.tenantId === broadcast.tenantId`
  - `recipient.broadcastId === broadcast.id`
  - `recipient.contact.tenantId === broadcast.tenantId`
  - `conversation.tenantId === broadcast.tenantId`
- Any cross-tenant attempt fails closed with `BroadcastHandlerError("TENANT_MISMATCH")` without making any Meta API call.

---

## 10. Production Activation Prerequisites

Before enabling `WHATSAPP_BROADCAST_ASYNC_ENABLED=true` in production:
1. Verify PostgreSQL migrations are deployed (`prisma migrate deploy`).
2. Verify Redis 7+ instance is connected and accessible.
3. Ensure background worker processes instantiate `createBroadcastDispatchWorker()` and `OutboxDispatcher`.
4. Verify provider rate limits for the target WABA phone number tier.
