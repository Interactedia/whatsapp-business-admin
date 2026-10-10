# Tenant HTTP Access

WA-01-05C introduces the first bounded tenant-aware HTTP read surface using centralized tenant authorization and tenant-scoped repository access.

**This route does not activate tenant isolation across legacy application routes.**

## New Route

```
GET /api/tenants/:tenantId/contacts/:contactId
```

Read-only endpoint that returns a single contact owned by the specified tenant.

## Authentication Requirements

The route requires an active NextAuth session. The authenticated user identity is resolved server-side from the JWT session token (`session.user.id`).

**Do not pass `userId` via URL, query parameters, headers, or request body.** The server-side principal is the only trusted identity source.

## Membership Verification

Every request goes through this authorization flow:

1. **Authenticate** — `auth()` returns the session or `null`
2. **Resolve principal** — extract `session.user.id` as the verified user identifier
3. **Read tenantId** — from URL path parameter (client-provided scope request only)
4. **Validate membership** — `resolveTenantContext({ userId }, tenantId)` verifies `TenantMembership`
5. **Return trusted TenantContext** — a `WeakSet`-marked context object

If any step fails, access is denied without disclosure of sensitive information.

## TenantContext Resolution

```ts
const session = await auth();
if (!session?.user) return fail(401, "Unauthorized");

const principal = { userId: session.user.id }; // server-verified
const context = await resolveTenantContext(principal, tenantId); // throws on failure
```

`resolveTenantContext` performs a database lookup for the `(userId, tenantId)` pair in `TenantMembership`. It returns a `TenantContext` only when:

- The user exists and is active
- The tenant exists
- A membership row links the user to the tenant

Global `ADMIN` and `AGENT` roles do **not** bypass this check.

## Data Access

After authorization, the route invokes the tenant-scoped repository:

```ts
const raw = await tenantMessagingRepository.findContact(context, contactId);
```

The repository `findContact` function:
- Accepts only a `WeakSet`-marked `TenantContext`
- Queries with `WHERE id = ? AND tenantId = ?` — enforcing tenant ownership at the database level
- Returns `null` for unknown, cross-tenant, or null-owned contacts

No direct Prisma `contact.findUnique` or `contact.findFirst` is used in the HTTP handler.

## HTTP Response Codes

| Scenario | HTTP Status | Response |
|----------|-------------|----------|
| Valid session + valid membership + existing contact | 200 | Contact object |
| No session | 401 | `{"error": "Unauthorized"}` |
| No membership / unknown tenant / malformed tenantId | 403 | `{"error": "Tenant access denied"}` |
| Contact not found (unknown, cross-tenant, null-owned) | 404 | `{"error": "Contact not found"}` |
| Malformed contactId | 403 | `{"error": "Tenant access denied"}` |

Error responses use generic messages to avoid disclosing tenant existence or membership status.

## Allowed Response Fields

The response exposes only these fields:

```ts
type ContactRead = {
  id: string;
  waId: string;
  name: string | null;
  profileName: string | null;
  tags: string[];
  notes: string | null;
  lastInboundAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
```

**Never exposed:** `tenantId`, `conversation`, relations, internal metadata, or other tenant identifiers.

## Fail-Closed Behavior

The route denies access by default for:

- Missing authentication
- Inactive users
- Unknown tenants
- Missing memberships
- Malformed identifiers
- Contacts owned by other tenants
- Contacts with `null` tenantId
- Unknown contacts

There is no fallback to legacy unscoped repositories.

## Security Limitations

1. **No authorization beyond membership** — membership verification does not grant permission to send, delete, or mutate contacts
2. **Legacy routes unchanged** — existing `/api/contacts` and `/api/contacts/[id]` routes do not use tenant enforcement
3. **No rate limiting** — this route inherits global Next.js limits only
4. **No audit logging** — access events are not persisted in this implementation unit
5. **No tenant role hierarchy** — all tenant members have equal read access to contacts

## Legacy Route Separation

The new route is completely isolated from existing routes:

| Route | Tenant Enforcement | Authorization |
|-------|-------------------|---------------|
| `/api/contacts` | None | `requireUser()` |
| `/api/contacts/[id]` (PATCH/DELETE) | None | `requireUser()` / `requireAdmin()` |
| `/api/tenants/:tenantId/contacts/:contactId` | **Yes** | Session + membership verification |

Existing routes continue to use their current authorization semantics.

## Future Integration Requirements

To extend this pattern to other resources:

1. Create or reuse a tenant-scoped repository for each entity type
2. Add a new route under `/api/tenants/:tenantId/`
3. Follow the same authorization flow: authenticate → resolve principal → validate membership → invoke repository → return allowlisted response
4. Add behavioral HTTP security tests for each new endpoint
5. Update this documentation with the new route

Deferred work includes: tenant switching UI, role-based read/write permissions, cross-tenant data boundaries, and PostgreSQL RLS.
