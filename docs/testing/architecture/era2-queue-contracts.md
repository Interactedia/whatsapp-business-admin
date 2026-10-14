# ERA 2 — Queue Contracts and Durability Specifications

**Task ID:** WA-ERA2-01-ARCHITECTURE-BASELINE  
**Status:** Architecture Proposal & Contracts  
**Date:** 2026-10-10  
**Scope:** Durable Queue Definitions, Job Payload Schemas, Idempotency Contracts, Failure Boundaries, and Open Decisions for Introducing Redis + BullMQ.

---

## 1. Principles & Durability Bounds

In accordance with `AGENTS.md`, `ADR-0002`, `ADR-0003`, and `ADR-0005`:

1. **PostgreSQL is the Canonical System of Record:**
   - Redis and BullMQ serve as asynchronous scheduling and execution infrastructure only.
   - Redis must **never** become the authoritative store for conversations, messages, or business state.
2. **Lean Reference-Based Payloads:**
   - Jobs in BullMQ queues must **never** embed full message text, customer PII, decrypted credentials, or raw media payloads.
   - Jobs must carry minimal durable database identifiers (e.g., `messageId`, `webhookEventId`, `tenantId`).
   - Workers re-fetch and re-verify state from PostgreSQL at execution time.
3. **Fail-Closed Tenant Isolation:**
   - `tenantId` in a job payload is treated as an untrusted routing hint.
   - The worker must re-verify ownership through trusted tenant access guards before performing any read or write.
4. **At-Least-Once Delivery Reality:**
   - Exactly-once execution across distributed networks is impossible.
   - All worker consumers must be strictly idempotent.

---

## 2. Proposed Queue Inventory & Job Contracts

ERA 2 introduces four distinct BullMQ queue channels to partition workloads and rate limits:

```text
[HTTP Webhook] ───► Inbound Ingress Queue (wa-webhook-inbound)
[App / API]     ───► Outbound Dispatch Queue (wa-message-outbound)
[Inbound / Webhook]─► Delivery Status Queue (wa-status-reconciliation)
[Broadcast Trigger]─► Broadcast Campaign Queue (wa-broadcast-dispatch)
```

---

### 2.1 Inbound Ingress Job Contract (`wa-webhook-inbound`)

* **Purpose:** De-couple HTTP response to Meta from synchronous inbound message processing (contact resolution, conversation creation, media download, and realtime fanout).
* **Producer:** `POST /api/webhook` (`src/app/api/webhook/route.ts`).
* **Consumer:** `InboundWebhookWorker`.
* **Queue Name:** `wa-webhook-inbound`.
* **Job Name:** `process-webhook-event`.
* **Payload Schema:**
  ```json
  {
    "webhookEventId": "clx... (CUID in PostgreSQL)",
    "metaPhoneNumberId": "109823482349",
    "receivedAt": "2026-10-10T12:00:00.000Z"
  }
  ```
* **Source of Truth Reference:** `WebhookEvent.id` in PostgreSQL.
* **Idempotency Key:** `inbound:event:${webhookEventId}`.
* **Side Effects:**
  1. Reads `WebhookEvent.payloadJson` from PostgreSQL.
  2. Resolves tenant phone via `resolveInboundPhoneNumber(metaPhoneNumberId)`.
  3. Upserts `Contact` and `Conversation`.
  4. Downloads media to local disk if required.
  5. Inserts `Message` row (`direction: "IN", status: "RECEIVED", waMessageId`).
  6. Dispatches realtime WebSocket event to target tenant.
  7. Updates `WebhookEvent.processedAt = now()`.
* **Retry Classification:**
  - Network timeouts (media download): Exponential backoff (initial 2s, max 30s, 3 retries).
  - Database transient deadlock: Exponential backoff (initial 1s, 3 retries).
  - Malformed payload: Terminal failure (Dead-Letter Queue, no retry).
* **Terminal Failure:** Mark `WebhookEvent.error = errorDescription`. Never retry poisoned payloads indefinitely.
* **Tenant Isolation:** Worker verifies `PhoneNumber.wabaAccount.tenantId` matching resolved account.

---

### 2.2 Outbound Dispatch Job Contract (`wa-message-outbound`)

* **Purpose:** Provide resilient outbound sending with durable PostgreSQL execution ownership and no automatic retransmission after the Meta send boundary is crossed.
* **Producer:** Operator Inbox route or API v1 route (`src/app/api/...`).
* **Consumer:** `OutboundMessageWorker`.
* **Queue Name:** `wa-message-outbound`.
* **Job Name:** `send-message`.
* **Payload Schema:**
  ```json
  {
    "messageId": "clx... (CUID of pre-persisted PENDING Message)",
    "tenantId": "clx... (Tenant ID)",
    "conversationId": "clx...",
    "idempotencyKey": "uuid-or-client-key"
  }
  ```
* **Source of Truth Reference:** `Message.id` in PostgreSQL.
* **Idempotency Key:** `outbound:msg:${messageId}`.
* **Side Effects:**
  1. Worker fetches `Message` where `id = messageId` and `tenantId = tenantId`.
  2. If `Message.status !== "PENDING"`, worker aborts (already processed).
  3. Resolves caller's `WabaAccount` decrypted credentials.
  4. Calls Meta Cloud API (`graphFetch`).
  5. Upon Meta 200: updates `Message` to `status: "SENT"`, sets `waMessageId: data.messages[0].id`.
  6. Emits `message:new` (or `message:status`) via realtime hub.
* **Retry Classification:**
  - `OutboundSendAttempt.metaRequestStartedAt` is written before the Meta HTTP call; expired `CLAIMED` leases are not automatically re-claimed because Meta may have accepted the original request.
  - Timeout, 429, 5xx, parse errors, and missing Meta message IDs transition the attempt to terminal `UNCERTAIN`; operator review is required before any manual retry.
  - Worker failure before the Meta boundary leaves no external side effect and may be retried only through explicit durable state, not by expired-lease auto-reclaim.
  - Meta HTTP 429 (Rate Limit): no automatic resend; mark `UNCERTAIN`.
  - Meta HTTP 5xx (Server Error): no automatic resend; mark `UNCERTAIN`. jitter.
  - Meta HTTP 4xx (Invalid recipient, outside 24h window): Terminal failure.
* **Terminal Failure:** Update `Message.status = "FAILED"`, persist `Message.errorJson = metaError`. Emits realtime update.
* **Tenant Isolation:** Worker performs `assertTenantOwned(tenantContext, conversation)`.

---

### 2.3 Delivery Status Reconciliation Job Contract (`wa-status-reconciliation`)

* **Purpose:** Asynchronously process Meta delivery receipts (`sent`, `delivered`, `read`, `failed`) and prevent out-of-order state overwrites.
* **Producer:** `POST /api/webhook` (`value.statuses`).
* **Consumer:** `DeliveryStatusWorker`.
* **Queue Name:** `wa-status-reconciliation`.
* **Job Name:** `reconcile-message-status`.
* **Payload Schema:**
  ```json
  {
    "metaMessageId": "wamid.HBgL...",
    "metaPhoneNumberId": "109823482349",
    "status": "SENT | DELIVERED | READ | FAILED",
    "timestamp": 1791238491,
    "error": null
  }
  ```
* **Source of Truth Reference:** `Message.waMessageId` in PostgreSQL.
* **Idempotency Key:** `status:${metaMessageId}:${status}`.
* **Side Effects:**
  1. Resolves `PhoneNumber` and verified `tenantId`.
  2. Queries `Message` by `waMessageId`.
  3. Evaluates State Progression Rule:
     - `PENDING` -> `SENT` -> `DELIVERED` -> `READ`
     - If current status is `READ`, incoming `DELIVERED` is discarded (noop).
     - If incoming is `FAILED`, updates `status = "FAILED"` and stores `errorJson`.
  4. Updates `BroadcastRecipient` status if message originated from a broadcast.
  5. Emits `message:status` realtime event.
* **Retry Classification:** Transient DB error (3 retries).
* **Terminal Failure:** Discarded after 3 attempts with error log.

---

### 2.4 Broadcast Campaign Job Contract (`wa-broadcast-dispatch`)

* **Purpose:** Replace in-memory `PQueue` with durable BullMQ scheduling that survives process restarts and enforces rate limits.
* **Producer:** `runBroadcast(broadcastId)` in `src/lib/whatsapp/broadcast.ts`.
* **Consumer:** `BroadcastDispatcherWorker`.
* **Queue Name:** `wa-broadcast-dispatch`.
* **Job Name:** `dispatch-broadcast-recipient`.
* **Payload Schema:**
  ```json
  {
    "broadcastId": "clx...",
    "recipientId": "clx... (BroadcastRecipient ID)",
    "tenantId": "clx..."
  }
  ```
* **Source of Truth Reference:** `BroadcastRecipient.id` in PostgreSQL.
* **Idempotency Key:** `broadcast:recp:${recipientId}`.
* **Side Effects:**
  1. Worker verifies `BroadcastRecipient.status === "PENDING"`.
  2. Resolves template content and recipient contact.
  3. Triggers outbound send.
  4. Updates `BroadcastRecipient.status = "SENT"`, links `waMessageId`.

---

## 3. Failure & Recovery Contracts

| Failure Mode | Worker & Queue Recovery Behavior |
|---|---|
| **Redis Broker Crash / Outage** | Application fails closed for queued tasks. Incoming webhooks persist raw `WebhookEvent` in PostgreSQL with `status: "PENDING_QUEUE"`. Once Redis recovers, a lightweight sweeper enqueues unprocessed rows. |
| **Worker Process Crash (SIGKILL / OOM)** | BullMQ automatically detects stalled jobs via lock renewal heartbeats (`lockDuration: 30000ms`). After lock expiry, another worker resumes the job. |
| **PostgreSQL Database Outage** | Worker catches connection error, leaves job in BullMQ retry queue with exponential delay. |
| **Meta Graph API Timeout** | Worker aborts after bounded timeout (15s). BullMQ increments attempt counter and retries with backoff. |
| **Duplicate Job Execution** | Consumer checks PostgreSQL message status first: if status is no longer `PENDING`, job logs deduplication hit and exits cleanly. |

---

## 4. Observability & Telemetry Contract

1. **Queue Operational Metrics:**
   - Queue depth gauges: `waiting`, `active`, `completed`, `failed`, `delayed`.
   - Latency metrics: Time from enqueue to execution start (`queue_latency_ms`).
   - Throughput counters: Jobs processed per minute partitioned by queue name and status (`success`, `failed`, `retried`).
2. **Log Redaction & PII Shielding:**
   - Log events must record: `jobId`, `queueName`, `tenantId`, `messageId`, `waMessageId`, duration, error code.
   - Log events must **never** record: message text, customer phone numbers (`waId`), contact names, media file content, Auth tokens, or decrypted App Secrets.

---

## 5. Explicit Consistency Decisions for Architectural Authority Review

The following three architectural decisions must be formally approved before implementing ERA 2 workers:

### Decision 1: Transactional Outbox vs. Direct Queue Push
* **Context:** When an operator or API sends a message, should the application:
  * *Option A (Transactional Outbox):* Write `Message` (PENDING) and an `OutboxJob` in a single PostgreSQL transaction. A local poller/CDC worker moves outbox rows to BullMQ. (Guarantees zero lost jobs, eliminates dual-write).
  * *Option B (Direct Enqueue):* Insert `Message` (PENDING) into PostgreSQL, then immediately call `queue.add()` in application code. (Simpler, but if the process crashes between DB commit and Redis push, the message remains stuck in `PENDING`).
* **Recommendation:** Use **Option B with a Periodic Stale-Job Sweeper** in PostgreSQL (`select * from Message where status = 'PENDING' and createdAt < now() - interval '2 minutes'`). This avoids heavy outbox polling while closing the dual-write crash window.

### Decision 2: Message Ordering Guarantee Scope
* **Context:** Does WhatsApp Business require strict FIFO ordering per customer conversation?
* **Recommendation:** WhatsApp conversations with customers generally require conversational ordering. BullMQ does not support dynamic topic partitions natively without BullMQ Pro groups or distinct job sequencing.
* **Proposed Contract:** Single-concurrency per conversation or lightweight job chaining (queue jobs with job ID keyed by `conversationId`).

### Decision 3: Transition and Fallback Strategy
* **Context:** How to roll out Redis/BullMQ safely without risking production downtime?
* **Recommendation:** Implement a feature flag / environment gate (`ENABLE_DURABLE_QUEUES=true`). If disabled or Redis is unconfigured, fall back gracefully to synchronous execution with clear operational warnings.

---

## 6. Recommended ERA 2 Sequencing Roadmap

1. **WA-ERA2-02-REDIS-FOUNDATION:**
   - Install `ioredis` and `bullmq` dependencies.
   - Configure native Redis connection manager with healthchecks and graceful shutdown.
   - Unit tests for Redis connectivity and fail-closed degradation.
2. **WA-ERA2-03-INBOUND-QUEUE:**
   - Implement `wa-webhook-inbound` and `InboundWebhookWorker`.
   - Update `POST /api/webhook` to enqueue after raw payload persistence.
3. **WA-ERA2-04-OUTBOUND-QUEUE:**
   - Implement `wa-message-outbound` and `OutboundMessageWorker`.
   - Adopt `PENDING` state and async Meta execution.
4. **WA-ERA2-05-STATUS-RECONCILIATION:**
   - Implement `wa-status-reconciliation` with monotonic state progression machine.
5. **WA-ERA2-06-BROADCAST-MIGRATION:**
   - Deprecate in-process `p-queue` and migrate `runBroadcast` to `wa-broadcast-dispatch`.
