# Historical Tenant Migration Strategy

## A. Purpose

This document defines a deterministic, auditable, non-destructive strategy for assigning existing WhatsApp messaging records to tenants in a future controlled migration.

This task does not execute the migration, does not create tenants, does not assign a default tenant, and does not modify historical records.

Repository evidence:

- `prisma/schema.prisma` defines nullable `tenantId` fields on `Contact`, `Conversation`, and `Message`.
- `prisma/migrations/20261009173500_add_nullable_tenant_ownership_to_messaging/migration.sql` adds those nullable columns and foreign keys.
- `docs/adr/0004-tenant-aware-domain.md` accepts tenant-aware design in principle and identifies legacy data migration as an open design question.
- `docs/LOCAL_DEVELOPMENT.md` states local build validation must use a non-production `DATABASE_URL` and must not use production credentials.

## B. Current architecture

### Tenant and WhatsApp ownership foundation

`prisma/schema.prisma` defines the future ownership hierarchy:

```text
Tenant
  -> WabaAccount
       -> PhoneNumber
```

Verified fields:

- `Tenant.id` is the primary key.
- `WabaAccount.id` is the primary key.
- `WabaAccount.tenantId` is required and references `Tenant.id` with `onDelete: Restrict`.
- `WabaAccount.metaWabaId` stores the Meta WABA identifier.
- `WabaAccount` has `@@unique([tenantId, metaWabaId])` and `@@index([tenantId])`.
- `PhoneNumber.id` is the primary key.
- `PhoneNumber.wabaAccountId` is required and references `WabaAccount.id` with `onDelete: Restrict`.
- `PhoneNumber.metaPhoneNumberId` stores the Meta phone number identifier.
- `PhoneNumber` has `@@unique([wabaAccountId, metaPhoneNumberId])` and `@@index([wabaAccountId])`.

### Legacy WABA configuration

`prisma/schema.prisma` defines `WabaSettings` as a singleton row: `id String @id @default("default")`.

Verified legacy fields relevant to ownership evidence:

- `wabaId`
- `phoneNumberId`
- `phoneNumberDisplay`
- `businessName`
- `metaAppId`
- encrypted `accessTokenEnc`
- `appSecret`
- `webhookVerifyToken`
- `apiVersion`

`src/lib/settings.ts` confirms runtime access still resolves through `getWabaConfig()`, which reads `prisma.wabaSettings.findUnique({ where: { id: "default" } })` and returns the singleton WABA configuration.

### Messaging models

`prisma/schema.prisma` defines:

- `Contact.id` as primary key.
- `Contact.tenantId` nullable, referencing `Tenant.id` with `onDelete: Restrict`.
- `Contact.waId` as `@unique`; the schema comment identifies it as E.164 digits without `+`.
- `Conversation.id` as primary key.
- `Conversation.tenantId` nullable, referencing `Tenant.id` with `onDelete: Restrict`.
- `Conversation.contactId` required and `@unique`, referencing `Contact.id` with `onDelete: Cascade`.
- `Message.id` as primary key.
- `Message.tenantId` nullable, referencing `Tenant.id` with `onDelete: Restrict`.
- `Message.conversationId` required, referencing `Conversation.id` with `onDelete: Cascade`.
- `Message.waMessageId` nullable and `@unique`.

The database currently has nullable ownership fields, but it does not enforce that `Contact.tenantId`, `Conversation.tenantId`, and `Message.tenantId` match across the entity chain.

### Runtime data flow evidence

Inbound webhook processing in `src/lib/whatsapp/webhook.ts`:

- `WebhookValue.metadata` may include `phone_number_id`.
- `processWebhook()` loads `getWabaConfig()` once and passes that config to inbound message handling.
- `handleInboundMessage()` uses `msg.from` as `waId`.
- `handleInboundMessage()` upserts `Contact` by `{ waId }` and creates/updates `Conversation` by `{ contactId }`.
- `handleInboundMessage()` creates `Message` with `conversationId`, direction `IN`, status `RECEIVED`, `waMessageId`, and payload fields, but does not set `tenantId`.
- `handleStatus()` updates messages by `waMessageId`; status payloads include `recipient_id`, but the function does not set tenant ownership.

Outbound sending in `src/lib/whatsapp/send.ts`:

- `ensureConversation()` upserts `Contact` by `{ waId }` and `Conversation` by `{ contactId }`, without `tenantId`.
- `sendMessage()` loads `getWabaConfig()` unless a config is supplied.
- `sendMessage()` creates a pending `Message` with `conversationId`, direction `OUT`, type, status `PENDING`, content fields, and optional `sentById`, but does not set `tenantId`.
- After Graph API send, `sendMessage()` updates the message with `status: "SENT"` and `waMessageId`.

These code paths prove that tenant ownership is not assigned at runtime today.

## C. Historical ownership evidence

Historical ownership may be assigned only from verified evidence. Evidence must identify the business-side WhatsApp asset, then map that asset to exactly one tenant through the persisted tenant foundation.

### Strong evidence

A record can be considered strongly supported for tenant assignment only when all of the following are true:

1. The record or its immutable context identifies a Meta business phone number or WABA.
2. That Meta identifier matches exactly one `PhoneNumber.metaPhoneNumberId` or `WabaAccount.metaWabaId` in the tenant foundation.
3. The matched `PhoneNumber` belongs to exactly one `WabaAccount`.
4. The matched `WabaAccount` belongs to exactly one `Tenant`.
5. The resulting tenant is consistent with the related `Contact`, `Conversation`, and `Message` chain.

Current repository evidence supports `WabaSettings.phoneNumberId` and `WabaSettings.wabaId` as legacy configuration identifiers, and `PhoneNumber.metaPhoneNumberId` / `WabaAccount.metaWabaId` as target ownership identifiers.

### Conditional evidence

A future migration may use the legacy singleton `WabaSettings` as evidence only if the migration snapshot proves that all historical records being migrated were produced under that same singleton business configuration.

The repository currently does not persist a per-message `phone_number_id`, per-conversation WABA identifier, or per-contact WABA identifier in the messaging models. `src/lib/whatsapp/webhook.ts` has access to webhook metadata at processing time, but the inspected code does not persist that metadata onto `Contact`, `Conversation`, or `Message`.

### Non-evidence

The following must not be used by themselves to assign ownership:

- `Contact.waId`, because it identifies the WhatsApp user/customer, not the business WABA or tenant.
- `Conversation.contactId`, because it only links a conversation to a contact.
- `Message.waMessageId`, because the schema stores it as a WhatsApp message identifier but does not encode tenant ownership in the database model.
- `Message.sentById`, because a user-to-tenant membership model is not implemented in the inspected schema.
- Current API route caller identity, because tenant authorization is out of scope and not implemented.
- The existence of only one configured WABA at runtime, unless a frozen migration snapshot proves the relevant historical period used that configuration exclusively.

## D. Known limitations

- Historical `Contact`, `Conversation`, and `Message` rows can have `tenantId = NULL` by design.
- Tenant isolation is not operational.
- Tenant authorization is not implemented.
- Runtime WABA routing is not implemented.
- `WabaSettings` remains the active legacy runtime configuration mechanism.
- Messaging models do not currently store `PhoneNumber.id`, `PhoneNumber.metaPhoneNumberId`, `WabaAccount.id`, or `WabaAccount.metaWabaId`.
- The database does not enforce equality between `Contact.tenantId`, `Conversation.tenantId`, and `Message.tenantId`.
- `Contact.waId` is globally unique in the current schema, which is incompatible with representing the same customer phone number independently across multiple WABAs without a later schema decision.
- Recent migrations may not be applied to the designated local PostgreSQL database. This document relies on repository schema and migration files, not on production or representative historical data counts.

## E. Ownership mapping rules

A future backfill must classify each candidate record into one of these outcomes:

1. `verified_assignable`
2. `unresolved_missing_evidence`
3. `unresolved_multiple_candidates`
4. `unresolved_inconsistent_chain`
5. `unresolved_missing_parent`
6. `already_assigned_consistent`
7. `already_assigned_conflict`

Rules:

1. Never assign a `tenantId` unless the tenant is derived from verified business-side ownership evidence.
2. Prefer business phone-number evidence over customer identity evidence.
3. Map `WabaSettings.phoneNumberId` only to `PhoneNumber.metaPhoneNumberId` when the migration snapshot proves the legacy setting applies to the historical records under review.
4. Map `WabaSettings.wabaId` only to `WabaAccount.metaWabaId` when the migration snapshot proves the legacy setting applies to the historical records under review.
5. If both phone-number and WABA evidence are present, they must resolve to the same `WabaAccount` and `Tenant`.
6. If a `Message` is assigned, its `Conversation` must be assigned to the same tenant.
7. If a `Conversation` is assigned, its `Contact` must either be assigned to the same tenant or be explicitly classified for later contact-splitting/schema treatment.
8. Existing non-null `tenantId` values must not be overwritten unless the value matches the verified assignment.
9. If evidence is incomplete, contradictory, or resolves to more than one tenant, leave `tenantId` unresolved.
10. Every candidate decision must be recorded in an audit artifact before any future write occurs.

## F. Ambiguous record classification

Ambiguous records must remain unresolved.

Classification requirements:

- Missing ownership evidence: no persisted WABA or phone-number context can be linked to the record.
- Multiple candidate tenants: one identifier maps to more than one tenant candidate, or multiple evidence sources disagree.
- Inconsistent identifiers: phone-number evidence and WABA evidence resolve to different ownership chains.
- Missing parent relationships: a `Message` references no valid `Conversation`, or a `Conversation` references no valid `Contact` in the migration snapshot.
- Duplicate identities across WABAs: the same customer `waId` appears in contexts that require different tenant ownership.
- Incomplete legacy metadata: `WabaSettings` lacks `wabaId` or `phoneNumberId`, or the values do not match tenant foundation rows.
- Preassigned conflict: a row already has a `tenantId` that differs from the verified candidate.

No ambiguous classification may be auto-resolved by selecting the first tenant, newest tenant, default tenant, sole active tenant, or current runtime setting.

## G. Contact/Conversation/Message consistency

### Contact ownership

`Contact.tenantId` must mean the contact record is owned in the context of one tenant. Because `Contact.waId` is globally unique, shared customer identities across multiple WABAs cannot be represented as separate contact records in the current schema.

Future migration must therefore treat shared-contact cases explicitly:

- If all related conversations and messages verify the same tenant, the contact may be assigned to that tenant.
- If related records verify different tenants, the contact must remain unresolved and require a later schema/product decision.
- Do not duplicate or split contacts in this task.

### Conversation ownership

`Conversation.tenantId` must match verified ownership context and must not conflict with its `Contact`.

A conversation can be assigned only when:

- Its contact relationship is valid.
- All messages in the conversation are either unresolved or resolve to the same tenant candidate.
- The contact can be assigned consistently to that same tenant, or the migration plan explicitly defers contact assignment.

### Message ownership

`Message.tenantId` must match its `Conversation.tenantId` when assigned.

A message cannot be assigned when:

- Its conversation is missing.
- Its verified tenant differs from the conversation candidate.
- Its `waMessageId` or payload does not provide business-side ownership evidence and no trusted parent context exists.

### Integrity not currently enforced by database

The current schema does not enforce:

- `Message.tenantId = Conversation.tenantId`.
- `Conversation.tenantId = Contact.tenantId`.
- Tenant consistency between `PhoneNumber`, `WabaAccount`, and historical messaging records.
- Per-WABA uniqueness of contacts.

A future implementation must enforce these checks in migration validation and later runtime authorization/query layers before claiming tenant isolation.

## H. Migration sequence

### PHASE A: Inventory and validate source records

Read-only inventory:

- Count `Contact`, `Conversation`, and `Message` records by `tenantId IS NULL` and `tenantId IS NOT NULL`.
- Verify orphan counts for `Conversation.contactId` and `Message.conversationId`.
- Snapshot `WabaSettings` values relevant to ownership: `wabaId`, `phoneNumberId`, `phoneNumberDisplay`, `businessName`, and `updatedAt`.
- Snapshot tenant foundation rows: `Tenant`, `WabaAccount`, and `PhoneNumber`.
- Record schema and migration version evidence.

Do not infer actual historical data counts from schema files.

### PHASE B: Identify verified ownership mappings

Build a read-only mapping table or artifact from verified evidence:

```text
source_identifier_type
source_identifier_value
target_tenant_id
target_waba_account_id
target_phone_number_id
evidence_source
evidence_timestamp
verification_status
```

Only mappings with exactly one tenant candidate are eligible.

### PHASE C: Produce deterministic migration candidates

Generate a dry-run candidate set before any write:

```text
entity_type
entity_id
current_tenant_id
candidate_tenant_id
classification
evidence_reference
parent_entity_id
conflict_reason
```

The candidate set must be stable across repeated runs against the same snapshot.

### PHASE D: Validate referential consistency

Validate:

- Every candidate tenant exists.
- Every candidate message has a valid conversation.
- Every candidate conversation has a valid contact.
- Message, conversation, and contact candidates do not conflict.
- Existing non-null tenant ownership is not contradicted.
- Ambiguous rows are classified and excluded from write candidates.

### PHASE E: Execute future controlled backfill

Design only in this task. Future execution, if approved, should:

- Run in bounded batches inside transactions.
- Update only rows whose `tenantId IS NULL` and whose candidate remains verified.
- Re-check the candidate condition immediately before each update.
- Refuse to overwrite conflicting non-null ownership.
- Persist an audit receipt for every batch.

No execution is authorized by this document.

### PHASE F: Verify migrated records

After a future authorized backfill:

- Compare updated row counts to approved candidate counts.
- Verify no unresolved row was updated.
- Verify no conflicting row was overwritten.
- Verify cross-entity tenant consistency.
- Verify application behavior remains unchanged until tenant isolation is explicitly implemented.

### PHASE G: Prepare subsequent authorization enforcement

Only after verified backfill and separate approval:

- Add tenant-scoped query enforcement.
- Add tenant authorization checks.
- Add runtime WABA routing.
- Add tests for positive and negative tenant boundaries.

Tenant isolation must not be claimed before these controls exist.

## I. Idempotency

A future backfill must be safe to retry and resume.

Requirements:

- Candidate generation must be pure read-only and deterministic for a fixed snapshot.
- Each update must be conditional on `tenantId IS NULL` or on matching the same already-assigned tenant.
- No update may overwrite a different non-null `tenantId`.
- Batch receipts must include input snapshot identity, candidate digest, executed row IDs, skipped row IDs, conflict row IDs, timestamps, and operator/tool version.
- Re-running the same batch must produce `already_assigned_consistent` for previously successful rows.
- Interrupted runs must resume from persisted receipts, not from process memory.
- The migration must not create duplicate contacts, conversations, messages, WABA accounts, or tenants.
- Conflict discovery must stop the affected batch and preserve evidence for review.

## J. Rollback and recovery

Before any future write:

- Take a PostgreSQL backup using the approved native database procedure.
- Export the ownership mapping snapshot.
- Export the deterministic candidate set.
- Record checksums/digests of the mapping and candidate artifacts.
- Record the application commit, Prisma schema, and migration state.

Recovery requirements:

- If validation fails before writes, stop with no data changes.
- If a batch fails before commit, roll back the transaction and keep the failure receipt.
- If a batch commits but later validation fails, use the batch receipt to identify exactly which rows were changed.
- Rollback must restore previous `tenantId` values from the pre-write snapshot or backup; because this strategy only permits assigning previously null ownership, rollback should set those specific rows back to `NULL` only when the receipt proves they were changed by the batch.
- Never rollback by broad tenant deletion or by truncating messaging tables.
- Stop migration immediately on unexpected non-null ownership, missing parent rows, changed mapping digest, or conflicting evidence.

## K. Data integrity validation

Required validation queries/checks for a future implementation:

- `Contact.tenantId` candidates reference existing `Tenant.id`.
- `Conversation.tenantId` candidates reference existing `Tenant.id`.
- `Message.tenantId` candidates reference existing `Tenant.id`.
- No assigned message has a different tenant from its conversation.
- No assigned conversation has a different tenant from its contact, unless explicitly deferred by an approved contact-sharing decision.
- No unresolved/ambiguous row receives a tenant.
- No existing conflicting non-null tenant is overwritten.
- Counts of eligible candidates match counts of updated rows.
- All skipped rows have a documented classification.
- Runtime smoke tests still pass because WhatsApp behavior is not changed by this strategy.

Documentation inventory verification for this task:

- This document references actual repository files and fields.
- It does not introduce SQL migration files.
- It does not modify Prisma schema.
- It does not modify runtime code.

## L. Security and tenant isolation implications

Historical ownership assignment is necessary but not sufficient for tenant isolation.

The repository evidence shows nullable ownership fields and tenant foundation models, but runtime paths inspected in `src/lib/whatsapp/webhook.ts`, `src/lib/whatsapp/send.ts`, and `src/lib/settings.ts` do not enforce tenant-scoped access or tenant-specific WABA routing.

Security requirements for later units:

- Authenticated identity must determine tenant context.
- Client-provided tenant IDs must not be trusted without authorization.
- API queries must filter by authorized tenant.
- WebSocket subscriptions must be tenant/resource authorized.
- WABA credentials must be resolved by tenant-owned phone number or WABA context, not by the singleton `WabaSettings` alone.
- Logs and receipts must avoid exposing tokens or unnecessary PII.

No tenant isolation claim is valid after this documentation-only task.

## M. Unresolved architectural decisions

The following decisions remain unresolved and require separate approved tasks:

- Whether `Contact.waId` should remain globally unique or become tenant/WABA-scoped.
- How to model shared customer phone numbers across multiple WABAs.
- Whether historical records should store explicit `PhoneNumber.id` or `WabaAccount.id` in addition to `tenantId`.
- How to migrate from singleton `WabaSettings` to tenant/WABA-scoped credential resolution.
- User-to-tenant membership and role model.
- Tenant-scoped API key model.
- Whether database-level constraints or application-level checks should enforce cross-entity tenant consistency.
- Whether PostgreSQL row-level security is useful in this stack.
- Exact operational procedure for native PostgreSQL backups and restore drills.

## N. Future implementation units

Suggested future units, each requiring a separate implementation packet:

1. Read-only migration inventory command/report.
2. Ownership mapping snapshot generator.
3. Dry-run candidate generator with deterministic classifications.
4. Cross-entity tenant consistency validator.
5. Controlled backfill executor with batch receipts and rollback support.
6. Contact identity/schema decision for multi-WABA customer overlap.
7. User/Tenant membership foundation.
8. Tenant-scoped authorization and query enforcement.
9. Runtime WABA/phone-number routing.
10. Post-migration verification and isolation acceptance tests.

## O. Explicit non-execution statement

This document is a strategy only.

No historical data was modified. No production database was accessed or modified. No database migration was applied. No tenant was created. No default tenant was assigned. No runtime code was changed. No Prisma model or constraint was changed. No Docker operation is part of this strategy.
