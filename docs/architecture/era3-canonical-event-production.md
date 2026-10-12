# ERA 3 — Canonical Event Production

**Task ID:** WA-ERA3-02
**Status:** Implemented
**Scope:** Canonical event builders for authoritative WhatsApp Business Admin state transitions. No durable relay storage, workers, delivery routes, retries, migrations, WebSocket changes, or consumer adapters are introduced.

## Authoritative transition sources

| Event | Existing authoritative source | Production boundary |
| --- | --- | --- |
| `inbound.message.received` | `src/lib/whatsapp/webhook.ts` `handleInboundMessage()` accepts a Meta message, resolves the persisted tenant/WABA/phone, upserts the tenant contact/conversation, and creates or finds the `Message` row keyed by `waMessageId`. | The committed `Message` row is the source. Duplicate webhook deliveries resolve to the same persisted message and therefore the same canonical event identity. |
| `outbound.message.accepted` | `src/lib/whatsapp/send.ts` `sendMessage()` and `enqueueOutboundMessage()` create the outbound `Message` row after tenant/WABA/conversation authorization. For the async path, `enqueueOutboundMessage()` commits `Message`, `OutboundSendAttempt`, and ERA 2 `OutboxEvent` in one transaction. | The committed outbound `Message` row in `PENDING` (async) or `SENT` after Meta ack (legacy sync) is the source. Accepted means accepted by this application for outbound processing, not delivered/read by Meta. |
| `outbound.message.status_changed` | `src/lib/whatsapp/webhook.ts` `handleStatus()` updates outbound message status from Meta callbacks; `src/lib/whatsapp/outbound/handler.ts` marks `SENT`, `FAILED`, or `UNCERTAIN` after the Meta send attempt. | The committed `Message.status` transition is the source. Repeated identical status updates are no-ops for canonical production. |
| `conversation.changed` | `src/lib/tenant/conversations.ts` `createBoundConversation()` and inbound `handleInboundMessage()` create conversations; explicit conversation status updates live in HTTP tenant conversation routes. Message activity updates `lastMessageAt`/`lastPreview` but is not a canonical conversation change by itself. | Only persisted creation or material status transitions (`OPEN`/`CLOSED`) qualify. Routine message previews and timestamps do not. |

The producer module is intentionally pure: it receives already-authoritative context and returns a validated `ExternalEvent`. It does not write the database, publish to Redis/BullMQ, call HTTP webhooks, or mutate existing ERA 2 behavior.

## Producer interface

`src/lib/events/producers` exports:

- `buildInboundMessageReceivedEvent(input)`
- `buildOutboundMessageAcceptedEvent(input)`
- `buildOutboundMessageStatusChangedEvent(input)`
- `buildConversationChangedEvent(input)`
- `buildConversationStatusChangedEvent(input)`

Every builder calls `validateExternalEvent()` from WA-ERA3-01 before returning. Invalid context fails explicitly with `ExternalEventValidationError`; the producer never repairs malformed data silently.

## Event identity strategy

IDs are deterministic strings:

- `evt:inbound.message.received:<tenantId>:<messageId>`
- `evt:outbound.message.accepted:<tenantId>:<messageId>`
- `evt:outbound.message.status_changed:<tenantId>:<messageId>:<previousStatus|NONE>:<status>`
- `evt:conversation.changed:<tenantId>:<conversationId>:<kind>:<status|NONE>`

The identity is based on canonical persisted identifiers and transition values, not wall-clock time or random UUIDs. `recordedAt` may differ between materializations without changing `id`.

## Duplicate and no-op behavior

- Duplicate inbound Meta deliveries reuse the persisted `Message` identified by unique `waMessageId`; the inbound event id stays stable because it uses `messageId`.
- Repeated outbound status notifications with the same previous/current status return `null` from `buildOutboundMessageStatusChangedEvent()`.
- Conversation status no-ops return `null` from `buildConversationStatusChangedEvent()`.
- Different message ids, status transitions, or conversation transition values produce different ids.

## Tenant and payload boundaries

Every producer input requires exactly one `tenantId`. Tenant ownership is encoded only in the envelope and `tenant` entity reference. Payloads use canonical resource ids (`messageId`, `conversationId`, `contactId`, `phoneNumberId`, `wabaAccountId`) and optional provider message aliases. Raw Meta webhook payloads, credentials, and consumer-specific business events are not accepted by the contract validator.

## Failure semantics

Producer failures are construction/validation failures. The producer has no side effects, so a failed event construction cannot partially commit business state. Integration points that need atomic persistence of both business state and future relay records belong to WA-ERA3-03's durable outbox task.

## Durability limitations

WA-ERA3-02 does not persist canonical events and does not claim reliable external delivery. A process may build an event and lose it unless a future durable outbox stores it after the authoritative transition. WA-ERA3-03 must consume this pure producer interface and insert canonical event records transactionally with state changes before any delivery worker is introduced.
