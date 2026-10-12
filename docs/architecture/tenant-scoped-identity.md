# Architectural Decision Record: Tenant-Scoped Contact and Conversation Identity

## Context and Problem Statement

In the baseline WhatsApp Business Admin architecture, `Contact` and `Conversation` models enforced global uniqueness:
- `Contact.waId @unique`
- `Conversation.contactId @unique`

This global identity prevented multiple independent tenants from managing their own contacts and customer conversations when the same customer (`waId`) interacted with different tenants or business phone numbers. Inbound webhooks also used unsafe global lookups (`prisma.contact.upsert({ where: { waId } })`), violating strict multi-tenant isolation.

## Approved Decision: Tenant-Scoped Identity (WA-ERA2-11A)

The user explicitly approved **OPTION 2: TENANT-SCOPED CONTACT IDENTITY**.

### 1. Canonical Identity Boundaries

- **Contact**: `@@unique([tenantId, waId])`
  - A customer contact belongs to exactly one verified tenant.
  - Distinct tenants can independently register, update, and manage contacts for the same `waId`.
  - Uniqueness within a tenant prevents duplicates while enabling cross-tenant separation.

- **Conversation**: `@@unique([tenantId, phoneNumberId, contactId])`
  - A conversation is bound to a verified tenant, a specific WhatsApp business phone (`phoneNumberId`), and a tenant-scoped contact (`contactId`).
  - Supports multiple business phone numbers operated by the same tenant without merging chat histories.
  - Replaces global `contactId @unique` with a 1:N contact-to-conversations relationship.

### 2. Additive, Non-Destructive Migration

Migration `20261011180000_tenant_scoped_contact_conversation_identity`:
- Drops global indexes:
  - `Contact_waId_key`
  - `Conversation_contactId_key`
- Creates tenant-scoped compound indexes:
  - `Contact_tenantId_waId_key` on `Contact(tenantId, waId)`
  - `Conversation_tenantId_phoneNumberId_contactId_key` on `Conversation(tenantId, phoneNumberId, contactId)`
  - Non-unique index `Conversation_contactId_idx` on `Conversation(contactId)` for performant foreign key lookups.

### 3. Application Lookups Updated

- **Inbound webhook processor** (`src/lib/whatsapp/webhook.ts`):
  - Resolves authenticated business phone and tenant first (`businessPhone.wabaAccount.tenantId`).
  - Upserts contact using `{ tenantId_waId: { tenantId, waId } }`.
  - Resolves conversation using `{ tenantId, contactId, phoneNumberId }`.
  - Historical unbound check fails closed before mutation.

- **Outbound sender** (`src/lib/whatsapp/send.ts`):
  - `ensureConversation(waId, name, senderPhone)` accepts an optional verified sender phone.
  - Resolves contact and conversation within `senderPhone.wabaAccount.tenantId`.
  - Maintains backward compatibility for legacy callers while enforcing tenant isolation.

- **Tenant conversation management** (`src/lib/tenant/conversations.ts`):
  - `startTenantConversation` queries `findFirst({ where: { tenantId, waId } })` ensuring lookups remain inside tenant boundaries.
  - `createBoundConversation` uses `{ tenantId, contactId, phoneNumberId }`.

- **Tenant messaging repository** (`src/lib/tenant/repository.ts`):
  - `createConversation` uses tenant-scoped upsert and creates phone-bound conversations.

- **REST API v1** (`src/app/api/v1/messages/route.ts`):
  - Contacts resolved using `findFirst({ where: { tenantId: context.tenantId, waId } })`.

## Verification Evidence

1. **Integration Test Suite**: `test/integration/tenant-contact-identity.test.ts`
   - Verified identical `waId` created across two separate tenants (`tenantA` and `tenantB`) without collision.
   - Verified cross-tenant lookups strictly isolate contacts by tenant ID.
   - Verified collision within the same tenant fails closed with `Contact_tenantId_waId_key`.
   - Verified multiple conversations per contact on distinct phone numbers under the same tenant.

2. **Regression Verification**:
   - `test/tenant-waba-routing.test.ts`: PASS (7/7)
   - `test/flow-broadcast-tenant-enforcement.test.ts`: PASS (4/4)
   - `test/integration/inbound-worker.test.ts`: PASS (7/7)
   - `test/integration/outbound-worker.test.ts`: PASS (17/17)
   - `test/integration/status-worker.test.ts`: PASS (6/6)
   - `test/integration/broadcast-worker.test.ts`: PASS (20/20)
   - `test/integration/stalled-job-recovery.test.ts`: PASS (17/17)
   - `test/integration/typing-indicator.test.ts`: PASS (16/16)
   - Unit and mock test suites: PASS (57 files, 570 tests)
