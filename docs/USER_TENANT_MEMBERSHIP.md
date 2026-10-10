# User Tenant Membership

WA-01-04 adds `TenantMembership` as an additive persistence foundation for future many-to-many relationships between existing application users and tenants.

## Model

`TenantMembership` stores one association between a `User` and a `Tenant`:

- `id`: stable membership identifier.
- `userId`: required foreign key to `User.id`.
- `tenantId`: required foreign key to `Tenant.id`.
- `createdAt`: membership record creation timestamp.

`User` has many `tenantMemberships`.
`Tenant` has many `tenantMemberships`.

## Uniqueness and indexes

A user can have at most one membership record for the same tenant. This is enforced with `@@unique([userId, tenantId])`.

Tenant lookups are supported with `@@index([tenantId])`. A separate `userId` index is intentionally not added because the unique `(userId, tenantId)` index already supports user-first membership lookups.

## Referential integrity

Membership records require existing `User` and `Tenant` rows. Both relations use restrictive deletion semantics so deleting a referenced user or tenant is blocked while membership rows exist.

No membership rows are created automatically by the schema or migration.

## Role compatibility

Existing application roles remain unchanged:

- `ADMIN`
- `AGENT`

Tenant membership does not add tenant-specific roles, permission inheritance, status, or provisioning behavior.

## Authentication and authorization limitations

Tenant membership persistence does not provide tenant authorization or tenant isolation.

This task does not change NextAuth configuration, JWT/session payloads, `requireUser`, `requireAdmin`, middleware, API permissions, or runtime tenant filters. Existing authentication and authorization behavior remains based on the current application role model.

## Future work

Future tenant-aware authorization work must separately define and implement:

- how tenant context is selected or resolved;
- how memberships are created, removed, and audited;
- whether tenant-scoped roles are needed;
- how tenant access is enforced in APIs, websocket subscriptions, and background processing;
- how legacy data is backfilled or mapped to tenant context;
- how security decisions are tested for cross-tenant isolation.

Those decisions are deferred to a separate approved implementation unit.
