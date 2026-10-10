# Tenant HTTP Access

WA-01-05C introduced the first bounded tenant-aware HTTP read surface using centralized tenant authorization and tenant-scoped repository access. WA-01-05D adds the matching protected conversation read endpoint.

**These routes do not activate tenant isolation across legacy application routes.**

## Tenant Contact Route

```
GET /api/tenants/:tenantId/contacts/:contactId
```

Read-only endpoint that returns a single contact owned by the specified tenant.

## Tenant Conversation Route

```
GET /api/tenants/:tenantId/conversations/:conversationId
```

Read-only endpoint that returns a single conversation owned by the specified tenant. The route requires the conversation row and its related contact row to both be owned by the trusted `TenantContext.tenantId`. Unknown conversations, cross-tenant conversations, null-owned conversations and contact ownership mismatches return `404`.

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

After authorization, the routes invoke the tenant-scoped repository:

```ts
const contact = await tenantMessagingRepository.findContact(context, contactId);
const conversation = await tenantMessagingRepository.findConversation(context, conversationId);
```

The repository `findContact` function:
- Accepts only a `WeakSet`-marked `TenantContext`
- Queries with `WHERE id = ? AND tenantId = ?` — enforcing tenant ownership at the database level
- Returns `null` for unknown, cross-tenant, or null-owned contacts

The repository `findConversation` function:
- Accepts only a `WeakSet`-marked `TenantContext`
- Queries with `WHERE id = ? AND tenantId = ? AND contact.tenantId = ?`
- Returns `null` for unknown, cross-tenant, null-owned, or contact-mismatched conversations

No direct Prisma `contact.findUnique`, `contact.findFirst`, `conversation.findUnique`, or `conversation.findFirst` is used in the HTTP handlers.

## HTTP Response Codes

| Scenario | HTTP Status | Response |
|----------|-------------|----------|
| Valid session + valid membership + existing contact | 200 | Contact object |
| Valid session + valid membership + existing conversation | 200 | Conversation object |
| No session | 401 | `{"error": "Unauthorized"}` |
| No membership / unknown tenant / malformed tenantId | 403 | `{"error": "Tenant access denied"}` |
| Contact not found (unknown, cross-tenant, null-owned) | 404 | `{"error": "Contact not found"}` |
| Conversation not found (unknown, cross-tenant, null-owned, contact mismatch, malformed conversationId) | 404 | `{"error": "Conversation not found"}` |

Malformed resource identifiers are rejected inside the tenant-scoped repository and surface as `404`, never disclosing whether the resource exists or which tenant owns it.

Error responses use generic messages to avoid disclosing tenant existence, membership status, or resource ownership.

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

Conversation responses expose only:

```ts
type ConversationRead = {
  id: string;
  contactId: string;
  status: "OPEN" | "CLOSED";
  unreadCount: number;
  lastMessageAt: Date | null;
  lastInboundAt: Date | null;
  lastPreview: string | null;
  assignedUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};
```

**Never exposed:** `tenantId`, relation objects, messages, credentials, internal metadata, or unrelated tenant identifiers.

## Fail-Closed Behavior

The routes deny access by default for:

- Missing authentication
- Inactive users
- Unknown tenants
- Missing memberships
- Malformed identifiers
- Contacts owned by other tenants
- Contacts with `null` tenantId
- Unknown contacts
- Conversations owned by other tenants
- Conversations with `null` tenantId
- Conversations whose related contact belongs to another tenant
- Unknown conversations

There is no fallback to legacy unscoped repositories.

## Security Limitations

1. **No authorization beyond membership** — membership verification does not grant permission to send, delete, or mutate contacts or conversations
2. **Legacy routes unchanged** — existing `/api/contacts`, `/api/contacts/[id]`, `/api/conversations`, and `/api/conversations/[id]/messages` routes do not use tenant enforcement
3. **No rate limiting** — these routes inherit global Next.js limits only
4. **No audit logging** — access events are not persisted in this implementation unit
5. **No tenant role hierarchy** — all tenant members have equal read access to the protected tenant contact and conversation reads

## Legacy Route Separation

The new route is completely isolated from existing routes:

| Route | Tenant Enforcement | Authorization |
|-------|-------------------|---------------|
| `/api/contacts` | None | `requireUser()` |
| `/api/contacts/[id]` (PATCH/DELETE) | None | `requireUser()` / `requireAdmin()` |
| `/api/conversations` | None | `requireUser()` |
| `/api/conversations/[id]/messages` | None | `requireUser()` |
| `/api/tenants/:tenantId/contacts/:contactId` | **Yes** | Session + membership verification |
| `/api/tenants/:tenantId/conversations/:conversationId` | **Yes** | Session + membership verification |

Existing routes continue to use their current authorization semantics.

## Tested HTTP Scenarios

Automated behavioral tests cover:

- Authorized conversation read returns `200` with allowlisted fields
- Missing authentication returns `401` at the handler level
- Missing membership and `ADMIN` without membership return `403`
- Unknown, cross-tenant, null-owned, and contact-mismatched conversations return `404`
- Forged `userId` headers are ignored
- Existing protected contact endpoint still rejects missing authentication

Build output includes `/api/tenants/[tenantId]/conversations/[conversationId]`, proving the dynamic route is registered.

### Live HTTP verification

WA-01-05-AUTH-01 updates the shared Auth.js boundary so anonymous `GET` requests to the two protected tenant read endpoints receive JSON authentication failures instead of browser redirects.

Live HTTP GET requests against an isolated local Next.js runtime now verify:

| Request | Status | Content-Type | Location |
|---------|--------|--------------|----------|
| `GET /api/tenants/test-tenant/contacts/test-contact` | `401` | `application/json` | none |
| `GET /api/tenants/test-tenant/conversations/test-conversation` | `401` | `application/json` | none |
| `GET /inbox` | `307` | none | `/login?callbackUrl=...` |

The route handlers still perform their own `auth()` check and return `401` if called without a session. The proxy-level JSON response prevents API/fetch consumers from receiving `/login` HTML while preserving browser-page login redirects.

No controlled NextAuth session fixture is introduced by this task, so authorized `200` and tenant-denied `403`/`404` remain verified at the handler level.

## Future Integration Requirements

To extend this pattern to other resources:

1. Create or reuse a tenant-scoped repository for each entity type
2. Add a new route under `/api/tenants/:tenantId/`
3. Follow the same authorization flow: authenticate → resolve principal → validate membership → invoke repository → return allowlisted response
4. Add behavioral HTTP security tests for each new endpoint
5. Update this documentation with the new route

Deferred work includes: tenant switching UI, role-based read/write permissions, cross-tenant data boundaries, and PostgreSQL RLS.
