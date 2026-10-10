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

## Security limitations

These repositories verify tenant membership and ownership only. They do not grant permission to send, delete, assign, mutate or otherwise act on messaging resources. Action authorization remains separate and must be added by future scoped tasks.

## Legacy compatibility

Existing API routes and Inbox behavior are unchanged. Legacy single-WABA runtime reads still use their existing direct Prisma queries until a future approved integration task adopts these repositories.

## Deferred work

Deferred work includes runtime integration, service authorization for non-human actors, route-level tenant enforcement, historical backfill, multi-WABA routing and PostgreSQL RLS.
