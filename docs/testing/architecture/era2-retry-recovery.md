# ERA 2 — Retry, Backoff and Recovery Hardening

**Task ID:** WA-ERA2-10-RETRY-BACKOFF-RECOVERY
**Status:** Implemented
**Scope:** Formalized failure classification, bounded retry policies, backoff policies, stalled-job handling, and operational recovery procedures across all BullMQ pipelines.

## Failure Classification

Errors are classified into four categories (defined in `src/lib/queue/failure-classification.ts`):

### Classification Matrix

| Error type | Category | BullMQ retry | Reason |
|---|---|---|---|
| HTTP 401 / 403 (auth) | `PERMANENT` | Never | Token invalid, retry would fail identically |
| HTTP 400 / 404 (validation) | `PERMANENT` | Never | Client error, retry would fail identically |
| HTTP 429 (rate limit) | `AMBIGUOUS_EXTERNAL` | Never | Meta may have accepted the request |
| HTTP 5xx (server error) | `AMBIGUOUS_EXTERNAL` | Never | Meta may have accepted the request |
| Other HTTP 4xx | `PERMANENT` | Never | Client error |
| Timeout / ECONNREFUSED | `AMBIGUOUS_EXTERNAL` | Never | Request may have arrived |
| Missing message ID response | `AMBIGUOUS_EXTERNAL` | Never | Ambiguous Meta response |
| Parse error | `AMBIGUOUS_EXTERNAL` | Never | Ambiguous Meta response |
| Redis/PostgreSQL transient | `INFRASTRUCTURE_UNAVAILABLE` | Yes | Safe to retry once recovered |
| Safe transient (not yet called Meta) | `SAFE_TRANSIENT` | Yes | No external side effect yet |

### Critical Invariants

1. **AMBIGUOUS_EXTERNAL never triggers BullMQ retry.** `retryable: false` is set for all Meta ambiguity outcomes (5xx, 429, timeout, parse error). The attempt stays `UNCERTAIN`; operators must explicitly review and retry.
2. **metaRequestStartedAt is set before crossing the Meta boundary.** This serves as evidence that Meta may have received the request. Recovery processes check this before authorizing a retry.
3. **UNCERTAIN is never auto-reclaimed.** `claimOutboundAttempt` only transitions `state IN ('PENDING', 'RETRYABLE')` to `CLAIMED`. `UNCERTAIN` is excluded.
4. **Expired CLAIMED without metaRequestStartedAt can be reclaimed.** If a worker crashes after claiming but before calling Meta, `releaseExpiredClaim` can transition `CLAIMED → RETRYABLE`. But if `metaRequestStartedAt` is set, the attempt is NOT eligible for auto-reclaim.

## Retry Policies

### Per-job-type Limits

| Job type | Queue | Max attempts | Backoff base | Backoff type |
|---|---|---|---|---|
| `inbound.webhook` | `wa-webhook-inbound` | 3 | 1000ms | exponential |
| `outbound.message` | `wa-message-outbound` | 3 | 1000ms | exponential |
| `status.reconciliation` | `wa-status-reconciliation` | 3 | 1000ms | exponential |
| `broadcast.dispatch` | `wa-broadcast-dispatch` | 3 | 1000ms | exponential |
| `outbox.publication` | (internal) | 5 | 5000ms | exponential |

**Outbound note:** BullMQ allows 3 attempts, but the handler determines whether to throw (trigger retry) or swallow based on `FailureClassificationResult.retryable`. `AMBIGUOUS_EXTERNAL` always sets `retryable: false` — the job completes successfully from BullMQ's perspective but the attempt is `UNCERTAIN`.

### Backoff Formula

```
delay = backoffBaseDelayMs * 2^(attempt - 1) + deterministic_jitter
jitter = (attemptSeed * attempt) % 1000  // bounded ±500ms, reproducible
```

Example (base 1000ms):
- Attempt 1: 1000ms ± 500ms
- Attempt 2: 2000ms ± 500ms
- Attempt 3: 4000ms ± 500ms

Max total wait per job: ~7s.

### Retry Storm Prevention

- Bounded attempts (3–5) prevent unbounded fan-out.
- Exponential backoff prevents thundering-herd on Meta API.
- Deterministic jitter (seed = jobId hash) prevents synchronized retries across multiple workers.
- BullMQ `removeOnFail: { count: 5000, age: 7d }` prevents job accumulation.

## Outbox Recovery

### Guarantees

| Scenario | Guarantee |
|---|---|
| Redis unavailable after PG commit | OutboxEvent is `RETRYABLE`; next poll recovers |
| Publication succeeds but ack lost | `CLAIMED` event with expired lease picked up; `replaceExisting: true` prevents duplicate job |
| Dispatcher crashes mid-batch | Expired `CLAIMED` events recovered by next dispatcher poll |
| Concurrent dispatchers | `FOR UPDATE SKIP LOCKED` prevents collision |
| Terminal event | Never re-claimed; inspectable for manual review |

### State Machine

```
PENDING → CLAIMED → PUBLISHED        (happy path)
PENDING → CLAIMED → RETRYABLE        (transient failure, bounded retries)
PENDING → CLAIMED → TERMINAL         (max attempts exhausted)
RETRYABLE → CLAIMED → PUBLISHED     (recovery)
RETRYABLE → CLAIMED → RETRYABLE     (transient failure again)
RETRYABLE → CLAIMED → TERMINAL       (max attempts exhausted)
CLAIMED (expired) → CLAIMED (new dispatcher) → PUBLISHED  (recovery after ack loss)
```

## Stalled-Job and Lease Safety

### BullMQ Stalled-Job Recovery

BullMQ's default stalled-job detection (30s stallInterval) marks jobs as stalled and re-queues them. This is safe because:

1. **All job processors re-validate PostgreSQL ownership before external effects.**
   - `outbound.handler`: `claimOutboundAttempt` before Meta call.
   - `broadcast.handler`: `claimBroadcastRecipient` before Meta call.
   - `inbound.processor`: deduplication via `WebhookEvent.id` uniqueness + tenant check.
   - `status.processor`: idempotency via `webhookEventId + messageId` checks.

2. **BullMQ job IDs are deterministic.** `replaceExisting: true` prevents duplicate job creation if the same work is re-queued.

3. **Global disabled stalled-job recovery is NOT used** unless explicitly configured per-queue and documented.

### Outbound Lease Safety

| Scenario | Behavior |
|---|---|
| Worker crashes before Meta call | `CLAIMED` → `RETRYABLE` after lease expiry; safe to re-claim |
| Worker crashes after metaRequestStartedAt | `metaRequestStartedAt` is set; NOT eligible for auto-reclaim; operator must review |
| UNCERTAIN state | NEVER re-claimed; `state IN ('PENDING', 'RETRYABLE')` only |
| Lease expires on UNCERTAIN | `claimOutboundAttempt` returns `claimed: false, existingState: 'UNCERTAIN'` |

## Broadcast Recovery

| Scenario | Behavior |
|---|---|
| Interrupted fan-out | Each recipient is independent; fan-out continues for remaining `PENDING` recipients |
| Worker restart | BullMQ replays missed jobs; `claimBroadcastRecipient` is idempotent |
| Duplicate BullMQ job | `ALREADY_CLAIMED` / `ALREADY_SENT` returned; no double-send |
| Campaign cancelled | `claimBroadcastRecipient` checks `broadcast.status === 'CANCELLED'` first; returns `status: 'cancelled'` |
| Ambiguous Meta response | Recipient stays `PENDING` with `UNCERTAIN` error; counters not incremented; operator review required |
| Concurrent workers | `claimBroadcastRecipient` uses `FOR UPDATE SKIP LOCKED`; only one worker can claim each recipient |

## Redis/PostgreSQL Outage Behavior

| Component | Behavior during outage |
|---|---|
| BullMQ enqueue | `QueueProducerError` thrown; Outbox event stays `RETRYABLE` |
| Outbox dispatcher poll | Redis failure → `markOutboxPublicationFailed` → `RETRYABLE`; event preserved |
| Worker Meta call | `AMBIGUOUS_EXTERNAL` classification; attempt → `UNCERTAIN` |
| Worker database query | Infra error classification; BullMQ retry triggered if attempts remain |
| PostgreSQL commit | Transactional outbox ensures event is committed before enqueue; no lost intent |

## Tenant Isolation During Recovery

Every recovered job re-validates:

1. **Tenant ownership** — `tenantId` in payload matches `Tenant.id`.
2. **WABA ownership** — `wabaAccountId` in payload matches `WabaAccount.id` for the tenant.
3. **Phone number ownership** — `phoneNumberId` belongs to the WABA.
4. **Broadcast ownership** — `broadcastId` belongs to the tenant and is not cancelled.
5. **Contact ownership** — `contactId` belongs to the tenant.

Payload `tenantId` is structural context, not authorization. Business records from PostgreSQL provide authorization.

## Operational Recovery Procedures

### Outbox event stuck in CLAIMED

1. Check `OutboxEvent.claimExpiresAt`.
2. If past: event is eligible for re-claim by any dispatcher.
3. No manual action needed; next dispatcher poll recovers.

### Outbox event in TERMINAL

1. Inspect `failureCode` and `failureMessage`.
2. Determine if failure was transient or permanent.
3. To manually retry:
   ```ts
   import { resetTerminalOutboxEvent } from "@/lib/outbox/recovery";
   await resetTerminalOutboxEvent(prisma, eventId, "operator-recovery");
   ```

### Outbound message in UNCERTAIN

1. Check `OutboundSendAttempt.metaRequestStartedAt`. If set, Meta may have accepted the message.
2. Check WhatsApp Business Manager for delivery status before retrying.
3. If confirmed not delivered: operator manually creates new attempt.
4. **NEVER auto-retry UNCERTAIN.**

### Broadcast recipient stuck in PENDING

1. Check `BroadcastRecipient.error` for `UNCERTAIN` or permanent failure.
2. If `UNCERTAIN`: same guidance as outbound above.
3. If permanent failure: inspect `BroadcastRecipient.error`.
4. Cancelled campaigns stop eligible sends automatically.

## Known Limitations

1. **BullMQ stalled-job detection is best-effort** (30s interval). A worker that hangs indefinitely while holding a job is not automatically detected.
2. **Per-process rate control** via `BROADCAST_DISPATCH_LIMITER` in `broadcast/worker.ts`. This is per-worker-process, not a global rate limit. Multiple worker processes each have their own limiter.
3. **metaRequestStartedAt is advisory**, not cryptographic proof that Meta received the request. It prevents auto-reclaim but does not guarantee delivery.
4. **Outbox recovery assumes dispatcher restart.** If all dispatchers are permanently down, events in `CLAIMED` state with expired leases will recover on next dispatcher restart, but there is no automatic promotion of stalled dispatchers.
5. **Feature flags remain disabled by default.** All asynchronous pipelines are gated behind `FEATURE_FLAG_*` environment variables.

## Test Commands

Real infrastructure tests (requires PostgreSQL and Redis):

```bash
# Unit + integration suite
npm run test

# Typecheck, lint, build
npx tsc --noEmit
npm run lint
npm run build
npx prisma validate

# Real Redis + PostgreSQL outbox recovery
REDIS_URL=redis://127.0.0.1:6379 \
  npx tsx test/integration/outbox-dispatch.test.ts

# Real Redis + PostgreSQL outbound recovery
REDIS_URL=redis://127.0.0.1:6379 \
  npx tsx test/integration/outbound-worker.test.ts

# Real Redis + PostgreSQL broadcast recovery
REDIS_URL=redis://127.0.0.1:6379 \
  npx tsx test/integration/broadcast-worker.test.ts

# Real Redis + PostgreSQL inbound recovery
REDIS_URL=redis://127.0.0.1:6379 \
  npx tsx test/integration/inbound-worker.test.ts

# Real Redis + PostgreSQL status recovery
REDIS_URL=redis://127.0.0.1:6379 \
  npx tsx test/integration/status-worker.test.ts

# Redis failure + reconnection
REDIS_URL=redis://127.0.0.1:6379 \
  npx tsx test/integration/redis-failure-handling.test.ts

# Retry policy unit tests
npx tsx test/lib/queue/retry-policy.test.ts

# Stalled-job + lease recovery tests
npx tsx test/integration/stalled-job-recovery.test.ts
```
