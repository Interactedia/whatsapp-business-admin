# ERA 2 — Typed Job Contracts and Producer Foundation

**Task ID:** WA-ERA2-04-JOB-CONTRACTS  
**Status:** Implemented  
**Scope:** Versioned queue job payloads, deterministic validation, job identity construction, and explicit producer infrastructure.

## Implemented boundaries

This layer defines infrastructure contracts only. It does not activate producers from WhatsApp HTTP routes, does not implement business workers, does not write to PostgreSQL, and does not choose a distributed consistency strategy.

PostgreSQL remains authoritative. Redis/BullMQ jobs contain persisted references and routing context only. Workers must refetch records and verify tenant/WABA/phone ownership before future side effects. A payload `tenantId` is structural context, not authorization.

## Persisted identifiers used

Verified from `prisma/schema.prisma`:

| Entity | Identifier |
|---|---|
| Tenant | `Tenant.id` |
| WABA | `WabaAccount.id`, with Meta id in `WabaAccount.metaWabaId` |
| WhatsApp phone number | `PhoneNumber.id`, with Meta id in `PhoneNumber.metaPhoneNumberId` |
| Conversation | `Conversation.id` |
| Message | `Message.id`, optional Meta id in `Message.waMessageId` |
| Broadcast | `Broadcast.id` |
| Broadcast recipient | `BroadcastRecipient.id` |
| Contact | `Contact.id` |
| Webhook event | `WebhookEvent.id` |

## Contract version

Current version: `1` (`JOB_CONTRACT_VERSION`). Unsupported versions are rejected before enqueue.

## Queue mapping

| Job type | Queue | BullMQ job name | Required references |
|---|---|---|---|
| `inbound.webhook` | `wa-webhook-inbound` | `process-webhook-event` | `tenantId`, `wabaAccountId`, `phoneNumberId`, `webhookEventId` |
| `outbound.message` | `wa-message-outbound` | `send-message` | `tenantId`, `wabaAccountId`, `phoneNumberId`, `conversationId`, `messageId` |
| `status.reconciliation` | `wa-status-reconciliation` | `reconcile-status` | `tenantId`, `wabaAccountId`, `phoneNumberId`, `messageId`; optional `waMessageId` |
| `broadcast.dispatch` | `wa-broadcast-dispatch` | `dispatch-broadcast-recipient` | `tenantId`, `wabaAccountId`, `broadcastId`, `broadcastRecipientId`, `contactId` |

## Validation behavior

`validateJobPayload` rejects:

- non-object payloads;
- unsupported job types;
- unsupported contract versions;
- missing or malformed identifiers;
- missing producer identity;
- invalid enqueue timestamp;
- sensitive field names anywhere in the payload (`token`, `secret`, `password`, `credential`, `authorization`, `accessToken`, `appSecret`).

Validation is structural only. It does not read business records and does not establish tenant authorization.

## Producer interface

`enqueueQueueJob(payload, options)` is explicitly invoked. Importing queue modules does not create queues, workers, events, Redis clients, or jobs.

Producer behavior:

- validates payload before enqueue;
- resolves queue and job name from `JOB_CONTRACTS`;
- builds a deterministic `jobId`;
- enqueues through the existing `createQueue` factory unless a caller provides an explicit queue;
- returns `{ ok, queueName, jobName, jobId, bullmqJobId, payload }`;
- propagates failures as `QueueProducerError`.

No production WhatsApp route calls this producer in this iteration.

## Error behavior

Producer errors are structured:

| Code | Meaning |
|---|---|
| `INVALID_PAYLOAD` | structural payload validation failed |
| `UNSUPPORTED_VERSION` | contract version is not supported |
| `MISSING_CONFIGURATION` | reserved for missing queue configuration surfaces |
| `QUEUE_UNAVAILABLE` | reserved for queue availability classification |
| `ENQUEUE_FAILURE` | BullMQ enqueue failed |

Diagnostics redact Redis credentials and never convert enqueue failures into success.

## Job identity

Identity format:

```text
<jobType>.v<version>.<tenantId>.<wabaAccountId>.<recordKind>.<recordId>
```

Examples:

```text
outbound.message.v1.tenant_1.waba_1.message.msg_1
broadcast.dispatch.v1.tenant_1.waba_1.broadcastRecipient.recipient_1
```

Allowed identity characters are alphanumeric plus `_ . : -`, with a bounded length. Tenant and WABA references are included to avoid accidental cross-tenant identity collisions.

Limitations: BullMQ `jobId` may help coalesce queued jobs with the same id, but it is not a durable exactly-once business execution guarantee. Final business idempotency depends on the future durability architecture.

## Future worker expectations

A future worker must:

1. fetch persisted records from PostgreSQL by the job references;
2. verify tenant/WABA/phone ownership through trusted application boundaries;
3. perform idempotent side effects;
4. persist business outcomes in PostgreSQL;
5. treat Redis/BullMQ state as execution infrastructure only.

## Known consistency limitations

Not implemented here:

- transactional outbox;
- direct enqueue recovery sweeper;
- FIFO guarantees;
- rollback/recovery policy;
- application-specific retry scheduling;
- business worker processors.

The next durability task must explicitly choose transactional outbox or direct enqueue with recovery sweeper before production message migration.

## Test commands

Unit and regression gates:

```bash
npm run test
npm run lint
npx tsc --noEmit
npm run build
```

Real Redis producer integration:

```bash
REDIS_URL=redis://127.0.0.1:6379 npx tsx test/integration/bullmq-producers.test.ts
```

The integration test uses an isolated `BULLMQ_PREFIX` and only obliterates queues created under that test prefix.
