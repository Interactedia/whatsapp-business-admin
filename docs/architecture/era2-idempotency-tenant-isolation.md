# WA-ERA2-11 cross-pipeline idempotency and tenant isolation

## Scope

This certification covers the existing WhatsApp messaging pipelines:

- `inbound.webhook`
- `outbound.message`
- `status.reconciliation`
- `broadcast.dispatch`

It reuses prior ERA 2 and WA-ERA2-11A evidence where tests exercise production behavior. No new queue, idempotency, tenant-authorization, schema, or production activation mechanism is introduced.

## Coverage matrix

| Guarantee | Implementation | Existing test | Covered/Missing | Action |
| --- | --- | --- | --- | --- |
| Contact identity is tenant-scoped | Prisma `Contact @@unique([tenantId, waId])`; tenant-scoped upserts in inbound/outbound/tenant APIs | `test/integration/tenant-contact-identity.test.ts`; `test/integration/tenant-identity-migration-rehearsal.test.ts` | COVERED | Reused |
| Conversation identity is tenant/phone/contact-scoped | Prisma `Conversation @@unique([tenantId, phoneNumberId, contactId])`; `ensureConversation` with verified phone | `test/integration/tenant-contact-identity.test.ts` | COVERED | Reused |
| Inbound duplicate webhook execution does not duplicate canonical messages | `WebhookEvent` persistence; `Message.waMessageId @unique`; inbound processor validates tenant/WABA/phone before `processWebhook` | `test/integration/inbound-worker.test.ts` | COVERED | Reused |
| Inbound replay/concurrency is idempotent | duplicate and concurrent job execution leave one message | `test/integration/inbound-worker.test.ts` | COVERED | Reused |
| Inbound same customer across tenants/phones remains isolated | tenant/WABA/phone resolution plus WA-ERA2-11A identity tests | `test/integration/inbound-worker.test.ts`; `test/integration/tenant-contact-identity.test.ts` | COVERED | Reused |
| Outbox publication replay is idempotent | `OutboxEvent` state machine and `claimOutboxEvents` PostgreSQL claims | `test/integration/outbox-postgres.test.ts`; `test/integration/outbox-dispatch.test.ts`; `test/integration/stalled-job-recovery.test.ts` | COVERED | Reused |
| BullMQ duplicate outbound jobs cannot double-send | `OutboundSendAttempt` one row per message and atomic claim | `test/integration/outbound-worker.test.ts` | COVERED | Reused |
| Concurrent outbound claims cannot double-send | PostgreSQL atomic `claimOutboundAttempt` | `test/integration/outbound-attempt-postgres.test.ts`; `test/integration/outbound-worker.test.ts` | COVERED | Reused |
| `metaRequestStartedAt` protects external side-effect boundary | started marker set before Meta call; recovery refuses expired claims after Meta boundary | `test/integration/outbound-worker.test.ts`; `test/integration/stalled-job-recovery.test.ts` | COVERED | Reused |
| `UNCERTAIN` remains non-retryable automatically | `markOutboundUncertain`; recovery and retry policy do not auto-release | `test/integration/outbound-worker.test.ts`; `test/integration/stalled-job-recovery.test.ts`; `test/lib/queue/retry-policy.test.ts` | COVERED | Reused |
| Status correlation requires persisted tenant/WABA/phone/message ownership | `reconcileStatusEvent` matches `messageId`, `waMessageId`, `tenantId`, `phoneNumberId`, and WABA ownership | `test/integration/status-worker.test.ts` | COVERED | Reused |
| Status updates are monotonic | `nextStatus` rank keeps `READ > DELIVERED > SENT` and avoids failed downgrades after delivery | `test/integration/status-worker.test.ts` | COVERED | Reused |
| Broadcast recipient identity is stable | `BroadcastRecipient.messageId @unique`; `@@unique([broadcastId, contactId])`; recipient claim creates/reuses one message | `test/integration/broadcast-worker.test.ts`; `test/integration/broadcast-outbox.test.ts` | COVERED | Reused |
| Duplicate broadcast jobs do not duplicate Meta sends | recipient and outbound attempt atomic claims | `test/integration/broadcast-worker.test.ts` | COVERED | Reused |
| Cancelled broadcasts cannot resume sends | `cancelBroadcast`; handler and claim reject `CANCELLED` | `test/integration/broadcast-worker.test.ts` | COVERED | Reused |
| Distinct legitimate campaigns remain independent | campaign/recipient identity is scoped by `broadcastId`; separate `BroadcastRecipient` rows and counters | `test/integration/broadcast-worker.test.ts`; `test/integration/broadcast-outbox.test.ts` | COVERED | Reused |
| Broadcast job cannot forge tenant/contact/campaign ownership | handler validates `broadcast.tenantId`, template tenant, recipient broadcast, recipient contact, and contact tenant | `test/integration/broadcast-worker.test.ts` | COVERED | Reused |
| Broadcast job cannot forge WABA/provider phone correlation | handler now verifies resolved phone belongs to job `wabaAccountId` and broadcast tenant before message creation or Meta call | `test/integration/broadcast-worker.test.ts` | MISSING -> COVERED | Added targeted regression `T7.1` and bounded fix |
| Admin/membership policy remains centralized | tenant APIs use trusted `TenantContext`; no new bypass added | unit/API tenant tests under `test/*tenant*.test.ts`; no production auth code changed | COVERED | Reused |
| Feature flags remain disabled by default | existing queue flags and settings unchanged | integration regressions; no flag files changed | COVERED | No action |

## Trusted ownership sources

- Inbound: `WebhookEvent` payload plus persisted `PhoneNumber -> WabaAccount -> Tenant`; processor validates job `tenantId`, `wabaAccountId`, and `phoneNumberId` against persisted ownership.
- Outbound: persisted `Message -> Conversation -> PhoneNumber -> WabaAccount -> Tenant`; `OutboundSendAttempt` is scoped by message and tenant and claimed atomically.
- Status: provider `waMessageId` is accepted only when it matches the persisted message, tenant, phone, and WABA chain.
- Broadcast: persisted `Broadcast -> Template`, `BroadcastRecipient -> Contact`, resolved phone/WABA, created `Message`, and `OutboundSendAttempt` must agree on tenant ownership.

HTTP or BullMQ payload fields are correlation hints only. They do not authorize work without persisted ownership validation.

## New test added

`test/integration/broadcast-worker.test.ts` adds `T7.1. forged WABA/phone correlation rejected before Meta call`.

The test creates a second tenant-owned WABA/phone, points the legacy settings phone at that foreign phone, then enqueues a broadcast job for tenant A with tenant A's WABA. The handler must reject before:

- creating a broadcast message,
- linking `BroadcastRecipient.messageId`, or
- invoking Meta.

## Defect corrected

Before this rework, `broadcast.dispatch` validated tenant/campaign/contact ownership but resolved the business phone from global settings without checking it matched the job `wabaAccountId`. A forged or stale settings phone could cross the provider-correlation boundary.

Fix: `src/lib/whatsapp/broadcast/handler.ts` now rejects unless the resolved phone's `wabaAccount.id` equals the job `wabaAccountId` and the phone's WABA tenant equals the broadcast tenant. The existing tenant/phone-scoped `ensureConversation` path is then used with that verified phone.

## Known limitations

- The system still does not claim exactly-once delivery to Meta; it provides business idempotency with durable claims and explicit `UNCERTAIN` handling.
- `UNCERTAIN` attempts require explicit operator recovery; automatic resend remains forbidden.
- Legacy global `WabaSettings` remains a compatibility source for selecting a phone, but dispatch now validates the selected phone against the job and persisted tenant ownership.
- This certification does not activate Webhook Relay, WebSockets, dashboards, Docker, or production rollout.

## Verification commands

Required deterministic gates:

```sh
npm run test
npm run lint
npx tsc --noEmit
npm run build
npx prisma validate
```

Real infrastructure suites used as evidence:

```sh
npx tsx test/integration/tenant-contact-identity.test.ts
npx tsx test/integration/tenant-identity-migration-rehearsal.test.ts
npx tsx test/integration/inbound-worker.test.ts
npx tsx test/integration/outbound-worker.test.ts
npx tsx test/integration/status-worker.test.ts
npx tsx test/integration/broadcast-worker.test.ts
npx tsx test/integration/outbox-postgres.test.ts
npx tsx test/integration/outbox-dispatch.test.ts
npx tsx test/integration/stalled-job-recovery.test.ts
npx tsx test/integration/bullmq-integration.test.ts
npx tsx test/integration/bullmq-producers.test.ts
npx tsx test/integration/redis-integration.test.ts
npx tsx test/integration/redis-failure-handling.test.ts
```
