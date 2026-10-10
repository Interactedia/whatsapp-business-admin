# Tenant Authorization Foundation

WA-01-05A establishes the centralized application authorization foundation for tenant-aware server code. It does not activate runtime tenant isolation across existing routes.

## Approved security architecture

The approved architecture is centralized application authorization. PostgreSQL RLS is deferred. Tenant access is checked by server-side code before tenant-scoped behavior is allowed.

## TenantContext contract

`resolveTenantContext(principal, requestedTenantId)` returns a `TenantContext` only after persisted membership is verified:

```ts
type TenantContext = {
  tenantId: string;
  userId: string;
  membershipId: string;
};
```

The input principal must come from a server-verified authentication boundary, such as the existing NextAuth session. A client request may include a tenant identifier, but that identifier is only a request to verify access; it is never proof of authorization.

## Authentication boundary

Existing authentication remains unchanged:

- `src/auth.ts` verifies credentials, rejects inactive users, and returns a NextAuth user identity.
- `src/auth.config.ts` copies the authenticated user id into `session.user.id` and the global role into `session.user.role`.
- `src/lib/api.ts` exposes `requireUser()` and `requireAdmin()` for legacy route behavior.
- `src/lib/api-keys.ts` verifies external API keys separately for `/api/v1` callers.

Tenant authorization starts after authentication. Do not pass raw client-supplied `userId` values to tenant authorization.

## Membership resolution

`resolveTenantContext` checks the persisted `TenantMembership` row by `(userId, tenantId)` and selects the related active `User` and `Tenant`. Access is denied when any required record is absent or invalid.

Global `ADMIN` and `AGENT` roles are not tenant membership and do not bypass this check.

## Fail-closed rules

The tenant module denies by default for:

- missing principal;
- invalid or inactive principal;
- missing tenant context;
- unknown tenant;
- missing membership;
- malformed identifiers;
- missing resource ownership;
- cross-tenant ownership mismatch;
- historical records with `null` tenant ownership.

Denials use a generic `TenantAuthorizationError` message to avoid unnecessary tenant existence disclosure.

## Authorization limitations

Membership verification only proves that a user belongs to a tenant. It does not grant arbitrary actions. Action authorization and tenant-scoped data access must be defined explicitly by future bounded implementation units.

The helper `assertTenantOwned(context, resource)` only validates that an already-loaded resource has non-null ownership matching the verified context. It is not a data access layer and does not fetch unrestricted tenant data.

## Service identity separation

Human tenant authorization is separate from service identity authorization. Do not reuse `TenantContext` automatically for:

- Meta webhooks;
- background workers;
- external API keys;
- external integrations;
- AI agents.

Those entry points require their own explicit authorization contracts before tenant-scoped effects are allowed.

## Legacy compatibility constraints

WA-01-05A does not change existing API routes, NextAuth behavior, global `ADMIN`/`AGENT` semantics, API key behavior, message routing, or websocket behavior. Existing legacy routes continue to use their current authorization until a later approved task applies tenant-scoped enforcement.

## Deferred runtime enforcement and RLS

Runtime tenant isolation across the application is deferred. PostgreSQL RLS remains deferred. Future work must add bounded tenant-scoped data operations and route enforcement without treating historical `null` ownership as accessible tenant data.
