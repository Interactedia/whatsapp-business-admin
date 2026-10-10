# Tenant Data Access

WA-01-05B introduces read-only tenant-scoped repositories for messaging data. Tenant-scoped repositories are not yet enforced across existing application API routes.

## Trusted TenantContext requirements

Repository operations require a `TenantContext` returned by `resolveTenantContext(principal, requestedTenantId)` from `src/lib/tenant`. That function verifies the authenticated user and requested tenant against persisted `TenantMembership` data before returning a runtime-marked context.

A plain object with `tenantId`, `userId` or `membershipId` is rejected. Raw `tenantId` or raw `userId` values are not authorization proof.

## Repository operations

`src/lib/tenant/repository.ts` exposes bounded read operations:

- `findContact(context, id)`
- `listContacts(context, pagination)` — tenant-filtered contact list with optional `search`, bounded `take` (1–200), optional `cursor`
- `findConversation(context, id)`
- `findMessage(context, id)`
- `listConversationMessages(context, conversationId, pagination)`

The module does not expose arbitrary Prisma access and does not perform writes.

## API Key tenant context (WA-ERA1-BATCH-C-R2)

`ApiKey.tenantId` is nullable for legacy rows but required for newly-created keys. `verifyApiKey()` returns an `ApiKeyPrincipal` containing `tenantId` derived from the validated database row; caller-supplied tenant identifiers do not override it. `resolveApiKeyTenantContext(principal)` marks a trusted tenant context only when the stored API key has a non-null tenant owner. Legacy null-owned keys therefore fail closed for tenant-owned data.

API key creation now requires an explicit `tenantId` and verifies persisted `TenantMembership` for the creator. Global `ADMIN` role does not bypass membership. Existing key hashing, prefix display, revocation and last-used behavior remain unchanged.

Realtime WebSocket connections are also tenant-bound: `/ws?tenantId=...` is treated as an access request, verified against the authenticated session cookie and `TenantMembership`, and then stored as trusted connection metadata. Message/conversation/status/flow realtime publications require a server-derived tenant id and are delivered only to matching tenant connections. Membership/session revocation is enforced by periodic connection revalidation (60s max window) and by rejecting unauthorized handshakes.

## Ownership verification rules

All reads include tenant ownership restrictions in the Prisma query itself. Missing records, records owned by another tenant and records with missing ownership all return the same denied result shape (`null` for lookups, `[]` for message listing).

Conversation reads require both:

- `Conversation.tenantId` matches the verified tenant.
- The related `Contact.tenantId` matches the verified tenant.

Message reads require:

- `Message.tenantId` matches the verified tenant.
- The related `Conversation.tenantId` matches the verified tenant.
- The conversation's related `Contact.tenantId` matches the verified tenant.

This prevents child records from bypassing parent ownership.

## Null ownership handling

Historical messaging rows may have `tenantId = null`. Tenant-scoped repositories deny those rows by requiring exact tenant matches in every read query.

## Pagination behavior

`listConversationMessages` is bounded. `take` must be an integer from `1` through `200`; invalid values are rejected. Results are ordered by `timestamp ASC, id ASC`. Optional `cursor` uses a message id and skips the cursor row.

## Sender binding and WABA ownership

ERA1-BATCH-B adds nullable `Conversation.phoneNumberId` as the explicit business sender binding. New tenant-owned conversations require a verified `PhoneNumber` that belongs to a `WabaAccount` owned by the trusted tenant. Historical conversations with `phoneNumberId = null` are not backfilled and cannot send outbound messages.

Outbound provider credentials resolve through:

1. trusted `TenantContext`;
2. owned `Conversation` and `Contact`;
3. bound `PhoneNumber`;
4. owning `WabaAccount` credential fields.

The send path does not fall back to singleton `WabaSettings` for tenant-scoped outbound messages. It also rejects sender reassignment by message payload; sends never change `Conversation.phoneNumberId`.

Inbound webhook binding uses Meta `metadata.phone_number_id` as the verified business phone identifier. Unknown, foreign, ambiguous, or historical unbound conversations fail closed instead of guessing from the customer phone number.

## Security limitations

These repositories verify tenant membership and ownership only. They do not grant permission to send, delete, assign, mutate or otherwise act on messaging resources outside the bounded tenant routes.

## Legacy compatibility

Existing tenant read routes and Inbox reads are preserved. Historical unbound rows remain readable where already tenant-owned, but outbound sends require sender binding. Singleton `WabaSettings` remains for legacy non-tenant provider surfaces such as template and flow administration until those surfaces receive separate scoped tenant routing.

## Deferred work

Deferred work includes service authorization for non-human actors, tenant isolation of remaining webhook/realtime surfaces, historical binding management UI, send idempotency/retry redesign, and PostgreSQL RLS.
