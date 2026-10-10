# ADR-0008 — Centralized tenant authorization foundation

- Status: **Accepted**
- Date: 2026-10-09

## Context

ADR-0004 requires tenant context to come from authenticated and authorized identity, never solely from a client-provided tenant id. WA-01-04 added persisted user tenant memberships. The application now needs a reusable server-side foundation for checking tenant membership before future tenant-scoped behavior is enabled.

## Decision

Use centralized application authorization for tenant access. PostgreSQL RLS is deferred.

Tenant authorization is a separate server-side step after authentication:

1. authenticate the principal through an approved boundary such as NextAuth;
2. accept a requested tenant identifier only as an access request;
3. verify persisted `TenantMembership` for the authenticated user and tenant;
4. return a narrow `TenantContext` for future tenant-scoped authorization and data access.

Global `ADMIN`/`AGENT` roles do not bypass tenant membership. Service identities such as Meta webhooks, workers, API keys and integrations require separate authorization contracts.

## Consequences

Existing authentication behavior and legacy route authorization remain unchanged until later scoped tasks apply tenant enforcement. Membership verification alone does not grant arbitrary actions or unrestricted tenant data access.

## Constraints

Tenant authorization must fail closed for missing identity, inactive users, malformed tenant ids, unknown tenants, missing memberships, missing ownership and cross-tenant ownership mismatches. Historical records with `null` tenant ownership are not tenant-accessible by default.

## Deferred work

Future implementation units must define bounded tenant-scoped data access and route enforcement. RLS remains deferred.
