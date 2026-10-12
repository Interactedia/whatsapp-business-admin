# ERA 3 — Canonical External Event Contract

**Task ID:** WA-ERA3-01
**Status:** Implemented
**Scope:** Versioned external event envelope, event families, runtime validation, and contract documentation. No delivery infrastructure is introduced.

## 1. Purpose

Downstream consumers (Mastra, Frappe, n8n, third-party CRM/automation backends) must be able to subscribe to WhatsApp channel activity without depending on Meta's webhook format or on internal worker contracts. This document defines the public, versioned envelope that such consumers can rely on.

This contract is intentionally narrow:

- It does **not** define delivery (HTTP, queue, retry, signing) — see ADR-0006 and the follow-up `WA-ERA3-02` task.
- It does **not** introduce new business semantics or consumer-specific logic.
- It does **not** change ERA 2 frozen behavior, in-memory queue contracts, the existing logging infrastructure, or administrative authorization.
- It does **not** modify the Prisma schema.

## 2. Architectural position

```text
Meta / WhatsApp  →  [existing webhook ingress]  →  WhatsApp Business Admin
                                                    │
                                                    └─ durable state (PostgreSQL)
                                                          │
                                                          └─ canonical external events (this contract)
                                                                │
                                                                └─ future relay to external consumers
```

PostgreSQL remains the system of record. The contract is a transport-shape declaration; producing envelopes for it is the subject of `WA-ERA3-02`.

## 3. Envelope

The canonical envelope is the only model an external consumer needs to parse. The TypeScript interface lives at `src/lib/events/contract.ts` and is exported as the public surface of the `events` module.

```ts
interface ExternalEvent<TPayload extends ExternalEventPayload = ExternalEventPayload> {
  id: string;            // stable, producer-issued, opaque, deduplication key
  type: ExternalEventType;
  version: 1;            // EXTERNAL_EVENT_CONTRACT_VERSION
  tenantId: string;      // exactly one tenant
  occurredAt: string;    // RFC 3339 UTC
  recordedAt: string;    // RFC 3339 UTC
  entities: ExternalEntityRef[];
  meta: {
    producer: string;          // e.g. "core", "queue-producer"
    correlationId?: string;    // optional upstream trace id
  };
  payload: TPayload["data"];   // event-family specific shape
}
```

### Field semantics

| Field | Required | Semantics |
|---|---|---|
| `id` | yes | Stable opaque identifier chosen by the producer. Consumers MUST deduplicate on this. UUIDv4 (or comparable) is recommended. |
| `type` | yes | One of the four declared event families. Unknown types are rejected at validation. |
| `version` | yes | Always `1` for this revision. Future revisions increment; older versions remain parseable per compatibility rules below. |
| `tenantId` | yes | Exactly one tenant. Cross-tenant events are not part of the contract. |
| `occurredAt` | yes | The moment the underlying state transition happened, RFC 3339 UTC. Not the publish time. |
| `recordedAt` | yes | The moment the producer materialized the envelope. Informational. |
| `entities` | yes | Canonical references the consumer can resolve through the platform's public APIs. The list is non-empty and each entry has a `kind` from a fixed set. |
| `meta` | yes | Producer label (required) and optional correlation id. No secrets here. |
| `payload` | yes | Event-family specific. Validated against the matching typed schema. |

### Entity kinds

The fixed set of `ExternalEntityRef.kind` values:

| Kind | Refers to |
|---|---|
| `tenant` | `Tenant.id` |
| `waba` | `WabaAccount.id` |
| `phone` | `PhoneNumber.id` |
| `conversation` | `Conversation.id` |
| `message` | `Message.id` |
| `contact` | `Contact.id` |
| `webhook_event` | `WebhookEvent.id` (raw inbound record; not a Meta payload) |
| `outbox_event` | `OutboxEvent.id` |

Each entity may carry an optional `providerId` (a Meta-side alias). Provider identifiers are reference-only and never used as the primary identifier of the envelope.

## 4. Event families

The contract declares only event families whose state is already authoritative in PostgreSQL.

| Event type | Triggered by | Payload highlights |
|---|---|---|
| `inbound.message.received` | Inbound WhatsApp message persisted as `Message` with `direction=IN`, `status=RECEIVED`. | `conversationId`, `messageId`, `contactId`, `phoneNumberId`, `wabaAccountId`, `type`, `receivedAt`, optional `providerMessageId`, optional truncated `preview`. |
| `outbound.message.accepted` | Outbound `Message` row created and accepted for delivery (after the durable outbox handoff). | `conversationId`, `messageId`, `contactId`, `phoneNumberId`, `wabaAccountId`, `type`, `acceptedAt`, optional `providerMessageId`. |
| `outbound.message.status_changed` | A terminal or material `MessageStatus` change for an outbound `Message` (SENT, DELIVERED, READ, FAILED, PENDING). | `conversationId`, `messageId`, `phoneNumberId`, `wabaAccountId`, `previousStatus`, `status`, `changedAt`, optional `providerMessageId`. |
| `conversation.changed` | Conversation creation or material change of observable state (status, assignment). | `conversationId`, `contactId`, optional `phoneNumberId`, optional `wabaAccountId`, `kind` (`CREATED`/`STATUS_CHANGED`/`REASSIGNED`), `status` (or null), `occurredAt`. |

Statuses and types are restricted to the contract's allowed sets:

- Message statuses: `PENDING`, `SENT`, `DELIVERED`, `READ`, `FAILED`, `RECEIVED`.
- Message types: `TEXT`, `IMAGE`, `VIDEO`, `AUDIO`, `DOCUMENT`, `STICKER`, `LOCATION`, `CONTACTS`, `TEMPLATE`, `INTERACTIVE`, `BUTTON`, `REACTION`. Internal `UNSUPPORTED` is not exposed.
- Conversation statuses: `OPEN`, `CLOSED`.

## 5. Runtime validation

`validateExternalEvent(input)` and `validateExternalEventOfType(input, type)` are the only public validators. Both throw `ExternalEventValidationError` with a stable `code` and field-level `details`. The error codes are:

| Code | Meaning |
|---|---|
| `INVALID_PAYLOAD` | Envelope or payload is not a well-formed object, or a payload field is invalid. |
| `UNSUPPORTED_TYPE` | The `type` field is not in the declared catalog. |
| `UNSUPPORTED_VERSION` | The `version` field is not the current `EXTERNAL_EVENT_CONTRACT_VERSION`. |
| `MISSING_TENANT` | `tenantId` is missing or malformed. |
| `INVALID_IDENTIFIER` | `id` is missing or malformed. |
| `SENSITIVE_FIELD` | A forbidden sensitive key was found in the envelope or its nested objects (token, secret, password, credential, authorization, accessToken, appSecret, bearer, privateKey, webhookPayload, rawPayload, metaPayload). |
| `INVALID_TIMESTAMP` | `occurredAt` or `recordedAt` is not an RFC 3339 string. |
| `INVALID_ENTITY` | An entity is missing, has an unknown `kind`, or has a malformed `id`/`providerId`. |
| `INVALID_REFERENCE` | `meta.correlationId` is malformed. |

Validation is deterministic and side-effect free. The same input always produces the same error code.

## 6. Versioning and compatibility

- The contract is currently `1` (`EXTERNAL_EVENT_CONTRACT_VERSION`).
- A new contract version is declared by adding a new constant (e.g. `EXTERNAL_EVENT_CONTRACT_VERSION = 2`) and a parallel `EXTERNAL_EVENT_CONTRACTS_V2` set.
- The runtime validator rejects anything other than the current version with `UNSUPPORTED_VERSION`. Older consumers may pin to a specific major version by switching their import.
- Compatibility rules:
  - **Additive** (new optional field, new event family): bump minor, keep `version` unchanged; consumers ignore unknown fields.
  - **Breaking** (rename, semantic shift, new mandatory field): bump major and increment `EXTERNAL_EVENT_CONTRACT_VERSION`; the prior major remains parseable until removed by an explicit deprecation ADR.
- Provider-specific payloads never enter the contract. Changes to Meta's webhook format do not change `EXTERNAL_EVENT_CONTRACT_VERSION`.

## 7. Identifier semantics

| Identifier | Stable across | Source of truth |
|---|---|---|
| `ExternalEvent.id` | Producer restarts, retries, replays | The producer; opaque to consumers. |
| `tenantId` | Contract lifetime | `Tenant.id` |
| `conversationId` / `messageId` / `contactId` / `phoneNumberId` / `wabaAccountId` | Contract lifetime | Respective Prisma models |
| `providerMessageId` (e.g. `wamid.*`) | Reference only | `Message.waMessageId` |

Consumers MUST NOT use `providerMessageId` as the only key to resolve a canonical entity. They SHOULD call the platform's tenant-scoped API using the canonical `id`.

## 8. Out of scope (this task)

The following are explicitly not part of `WA-ERA3-01` and belong to subsequent tasks:

- HTTP webhook delivery and signing (proposed in ADR-0006; tracked separately).
- Redis / BullMQ queues and workers for delivery.
- Database schema changes (the contract is purely additive at the application layer).
- Retry, DLQ, and backoff.
- WebSocket realtime relay.
- Frontend changes.
- CRM, Mastra, or n8n-specific adapters and business logic.
- Production of envelopes from existing code paths. `WA-ERA3-02` will introduce producers.

## 9. Code map

| Path | Role |
|---|---|
| `src/lib/events/contract.ts` | Type definitions and constant catalogs. |
| `src/lib/events/validation.ts` | `validateExternalEvent`, `validateExternalEventOfType`, `ExternalEventValidationError`. |
| `src/lib/events/index.ts` | Public barrel. Only this surface is part of the contract. |
| `test/lib/events/external-event-contract.test.ts` | Contract tests (happy path, rejection, sensitive data, payload isolation, tenant ownership). |

## 10. Acceptance evidence

- `npx tsc --noEmit` passes.
- `npm run lint` passes.
- `npm test` passes (596 existing + 37 new).
- `npm run build` passes.
- `npx prisma validate` passes.
- `git diff --check` passes.
- No migrations, no delivery infrastructure, no consumer-specific logic, no ERA 2 changes.
