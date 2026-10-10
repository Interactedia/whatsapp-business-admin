# Tenant HTTP Access

WA-01-05C introduced the first bounded tenant-aware HTTP read surface using centralized tenant authorization and tenant-scoped repository access. WA-01-05D adds the matching protected conversation read endpoint. WA-01-05G-R2 adds the tenant contact list endpoint, canonical tenant navigation for Contacts, and removes the legacy global contact GET. WA-01-05H adds tenant-scoped contact write operations (POST/PATCH/DELETE), migrates the Contacts UI to tenant-aware endpoints, and removes the legacy global contact write handlers.

**These routes do not activate tenant isolation across legacy application routes.**

## Tenant Contact Write Routes

### Create Contact

```
POST /api/tenants/:tenantId/contacts
```

Creates a new contact owned by the verified tenant. Requires a valid session and membership. The `tenantId` is assigned from the trusted `TenantContext`, not from the request body.

**Request body:**
```json
{
  "waId": "919812345678",
  "name": "Contact Name",
  "tags": ["vip", "lead"],
  "notes": "Contact notes"
}
```

**Responses:**
- `201 Created` — Contact created successfully
- `400 Bad Request` — Invalid or missing waId
- `401 Unauthorized` — No session
- `403 Forbidden` — No membership
- `409 Conflict` — Contact with that waId already exists

### Update Contact

```
PATCH /api/tenants/:tenantId/contacts/:contactId
```

Updates an existing contact owned by the verified tenant. Returns `404` for cross-tenant or null-owned contacts.

**Request body:**
```json
{
  "name": "Updated Name",
  "tags": ["vip", "updated"],
  "notes": "Updated notes"
}
```

**Responses:**
- `200 OK` — Contact updated successfully
- `400 Bad Request` — Invalid payload
- `401 Unauthorized` — No session
- `403 Forbidden` — No membership
- `404 Not Found` — Contact not found (unknown, cross-tenant, or null-owned)

### Delete Contact

```
DELETE /api/tenants/:tenantId/contacts/:contactId
```

Deletes a contact owned by the verified tenant. Returns `404` for cross-tenant or null-owned contacts.

**Responses:**
- `200 OK` — `{"deleted": true}`
- `401 Unauthorized` — No session
- `403 Forbidden` — No membership
- `404 Not Found` — Contact not found (unknown, cross-tenant, or null-owned)

## Tenant Contact List Route

```
GET /api/tenants/:tenantId/contacts
```

Read-only endpoint that returns a list of contacts owned by the specified tenant. Supports optional `search` (name/profileName/waId contains), `take` (1–200, default 200), and `cursor` pagination. Only contacts with exact `tenantId` match are returned — other tenants' contacts and null-owned contacts are excluded. Tenant isolation is applied before pagination.

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

## Canonical Tenant Navigation

Contacts uses explicit tenant-scoped navigation:

```
/t/:tenantId/contacts
```

The existing `/contacts` page no longer performs global contact reads. It presents an explicit tenant selection view listing only the authenticated user's authorized tenant memberships. No tenant is auto-selected, no implicit tenant cookie exists, and the first membership is not chosen automatically. Users without memberships see a clear no-access state.

Selecting a tenant navigates to `/t/:tenantId/contacts`, which verifies `TenantMembership` server-side before rendering tenant-sensitive information. Unauthorized tenant navigation shows the selector with authorized memberships instead of tenant content.

## Legacy Global Contact Operations Removal

### Legacy Global GET Removal (WA-01-05G-R2)

The legacy `GET /api/contacts` endpoint is removed. It previously returned an unscoped list of all contacts (up to 500) to any authenticated user. No compatibility alias exists.

### Legacy Global Write Removal (WA-01-05H)

The legacy contact write operations are removed:
- `POST /api/contacts` — removed
- `PATCH /api/contacts/:id` — removed
- `DELETE /api/contacts/:id` — removed

All contact write operations now use tenant-scoped endpoints with membership verification.

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
// Read operations
const contacts = await tenantMessagingRepository.listContacts(context, { search, take, cursor });
const contact = await tenantMessagingRepository.findContact(context, contactId);
const conversation = await tenantMessagingRepository.findConversation(context, conversationId);

// Write operations
const created = await tenantMessagingRepository.createContact(context, { waId, name, tags, notes });
const updated = await tenantMessagingRepository.updateContact(context, contactId, { name, tags, notes });
const deleted = await tenantMessagingRepository.deleteContact(context, contactId);
```

The repository `listContacts` function:
- Accepts only a `WeakSet`-marked `TenantContext`
- Queries with `WHERE tenantId = ?` — enforcing tenant ownership at the database level before pagination
- Excludes other tenants' contacts and null-owned contacts
- Bounded `take` (1–200, default 200), optional `cursor`

The repository `findContact` function:
- Accepts only a `WeakSet`-marked `TenantContext`
- Queries with `WHERE id = ? AND tenantId = ?` — enforcing tenant ownership at the database level
- Returns `null` for unknown, cross-tenant, or null-owned contacts

The repository `findConversation` function:
- Accepts only a `WeakSet`-marked `TenantContext`
- Queries with `WHERE id = ? AND tenantId = ? AND contact.tenantId = ?`
- Returns `null` for unknown, cross-tenant, null-owned, or contact-mismatched conversations

The repository `createContact` function:
- Accepts only a `WeakSet`-marked `TenantContext`
- Assigns `tenantId` from the trusted context, not from request data
- Creates contact with specified fields

The repository `updateContact` function:
- Accepts only a `WeakSet`-marked `TenantContext`
- Verifies ownership through `findContact` before mutation
- Returns `null` for cross-tenant or null-owned contacts

The repository `deleteContact` function:
- Accepts only a `WeakSet`-marked `TenantContext`
- Verifies ownership through `findContact` before deletion
- Returns `null` for cross-tenant or null-owned contacts

No direct Prisma `contact.findUnique`, `contact.findFirst`, `conversation.findUnique`, or `conversation.findFirst` is used in the HTTP handlers.

## HTTP Response Codes

| Scenario | HTTP Status | Response |
|----------|-------------|----------|
| Valid session + valid membership + contact created | 201 | Contact object |
| Valid session + valid membership + contact updated | 200 | Contact object |
| Valid session + valid membership + contact deleted | 200 | `{"deleted": true}` |
| Valid session + valid membership + contact list | 200 | Array of contact objects |
| Valid session + valid membership + existing contact | 200 | Contact object |
| Valid session + valid membership + existing conversation | 200 | Conversation object |
| No session | 401 | `{"error": "Unauthorized"}` |
| No membership / unknown tenant / malformed tenantId | 403 | `{"error": "Tenant access denied"}` |
| Invalid payload / invalid pagination | 400 | `{"error": "Invalid request"}` |
| Contact not found (unknown, cross-tenant, null-owned) | 404 | `{"error": "Contact not found"}` |
| Conversation not found (unknown, cross-tenant, null-owned, contact mismatch, malformed conversationId) | 404 | `{"error": "Conversation not found"}` |
| Duplicate waId on create | 409 | `{"error": "A contact with that number already exists."}` |

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

1. **No authorization beyond membership** — membership verification does not grant permission to send or mutate conversations
2. **Legacy routes removed** — `/api/contacts` and `/api/contacts/[id]` no longer support write operations
3. **No rate limiting** — these routes inherit global Next.js limits only
4. **No audit logging** — access events are not persisted in this implementation unit
5. **No tenant role hierarchy** — all tenant members have equal write access to tenant contacts

## Legacy Route Separation

The tenant-scoped routes are completely isolated from existing routes:

| Route | Tenant Enforcement | Authorization |
|-------|-------------------|---------------|
| `/api/contacts` | **Removed** | N/A |
| `/api/contacts/[id]` | **Removed** | N/A |
| `/api/conversations` | None | `requireUser()` |
| `/api/conversations/[id]/messages` | None | `requireUser()` |
| `/api/tenants/:tenantId/contacts` | **Yes** | Session + membership verification |
| `/api/tenants/:tenantId/contacts/:contactId` (GET) | **Yes** | Session + membership verification |
| `/api/tenants/:tenantId/contacts/:contactId` (PATCH/DELETE) | **Yes** | Session + membership verification |
| `/api/tenants/:tenantId/conversations/:conversationId` | **Yes** | Session + membership verification |

The legacy global contact write routes are removed. All contact write operations now require membership verification.

## Tested HTTP Scenarios

Automated behavioral tests cover:

### Contact Write Operations (WA-01-05H)
- Authorized same-tenant contact creation returns `201` with allowlisted fields
- Created contact has correct `tenantId` from context
- Missing authentication returns `401`
- Missing membership returns `403`
- `ADMIN` without membership returns `403`
- Invalid waId format returns `400`
- Duplicate waId returns `409`
- Cross-tenant contact update returns `404`
- Null-owned contact update returns `404`
- Cross-tenant contact deletion returns `404`
- Null-owned contact deletion returns `404`
- Invalid update payload returns `400`
- `tenantId` cannot be passed in request body for ownership reassignment

### Contact Read Operations
- Authorized conversation read returns `200` with allowlisted fields
- Missing authentication returns `401` at the handler level
- Missing membership and `ADMIN` without membership return `403`
- Unknown, cross-tenant, null-owned, and contact-mismatched conversations return `404`
- Forged `userId` headers are ignored

### Legacy Route Removal
- `POST /api/contacts` is undefined (removed)
- `PATCH /api/contacts/:id` is undefined (removed)
- `DELETE /api/contacts/:id` is undefined (removed)
- `POST /api/tenants/:tenantId/contacts` is defined
- `PATCH /api/tenants/:tenantId/contacts/:id` is defined
- `DELETE /api/tenants/:tenantId/contacts/:id` is defined

Build output includes `/api/tenants/[tenantId]/contacts/[contactId]`, proving the dynamic route is registered for write operations.

### Live HTTP verification

WA-01-05-AUTH-01 updates the shared Auth.js boundary so anonymous `GET` requests to the protected tenant endpoints receive JSON authentication failures instead of browser redirects.

Live HTTP requests against an isolated local Next.js runtime now verify:

| Request | Status | Content-Type | Location |
|---------|--------|--------------|----------|
| `GET /api/tenants/test-tenant/contacts/test-contact` | `401` | `application/json` | none |
| `GET /api/tenants/test-tenant/conversations/test-conversation` | `401` | `application/json` | none |
| `POST /api/tenants/test-tenant/contacts` | `401` | `application/json` | none |
| `PATCH /api/tenants/test-tenant/contacts/test-contact` | `401` | `application/json` | none |
| `DELETE /api/tenants/test-tenant/contacts/test-contact` | `401` | `application/json` | none |
| `GET /inbox` | `307` | none | `/login?callbackUrl=...` |

The route handlers perform their own `auth()` check and return `401` if called without a session. The proxy-level JSON response prevents API/fetch consumers from receiving `/login` HTML while preserving browser-page login redirects.

No controlled NextAuth session fixture is introduced by this task, so authorized `200`/`201` and tenant-denied `403`/`404` remain verified at the handler level.

## Future Integration Requirements

To extend this pattern to other resources:

1. Create or reuse a tenant-scoped repository for each entity type
2. Add a new route under `/api/tenants/:tenantId/`
3. Follow the same authorization flow: authenticate → resolve principal → validate membership → invoke repository → return allowlisted response
4. Add behavioral HTTP security tests for each new endpoint
5. Update this documentation with the new route

Deferred work includes: tenant switching UI, role-based read/write permissions, cross-tenant data boundaries, and PostgreSQL RLS.
