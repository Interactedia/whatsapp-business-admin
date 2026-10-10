# Tenant API Isolation Surface Inventory

Task: `WA-01-05E`  
Date: 2026-10-09  
Status: inventory only; no authorization, schema, runtime, or application behavior changes.

## Scope and methodology

This inventory was produced from repository source inspection only. It covers the installed Next.js App Router API handlers, the auth/proxy boundary, tenant authorization helpers, tenant-aware read repositories, WhatsApp inbound/outbound code, realtime WebSocket fan-out, and in-process background entry points.

Verification basis:

- `git log -5 --oneline` contains the accepted implementation commits:
  - `8116702 feat(tenancy): add protected tenant contact endpoint`
  - `d6f8e8a feat(tenancy): add protected tenant conversation endpoint`
  - `6ffed39 fix(auth): WA-01-05-AUTH-01 return 401 for protected tenant APIs`
- `src/app/api/**/route.ts` contains 47 route handler files.
- All HTTP surfaces listed below map to actual files under `src/app/api`.
- Existing unrelated worktree changes were observed and are not part of this inventory: `README.md`, `src/app/login/page.tsx`, `src/app/login/actions.ts`, `.playwright-mcp/`.

Classification meanings:

- **PROTECTED**: source evidence shows tenant membership authorization and tenant-filtered data access for the relevant operation.
- **PARTIAL**: some authentication, signature, token, or endpoint-specific protection exists, but tenant isolation is incomplete or not tied to a trusted `TenantContext`.
- **LEGACY**: existing authenticated/admin/API-key behavior is global or single-installation oriented and is not tenant-aware. This does not by itself prove exploitability.
- **UNKNOWN**: source evidence is insufficient to classify tenant isolation safely.

## Current security model

### Authentication and proxy behavior

- `src/proxy.ts` uses Auth.js/NextAuth proxy protection for most routes and explicitly excludes `api/auth`, `api/webhook`, `api/v1`, `api/whatsapp/flows/data`, Next internals, and static assets (`src/proxy.ts:7-12`).
- `src/auth.config.ts` requires a logged-in session for proxy-matched paths and returns JSON `401` for unauthenticated `GET` requests to the two protected tenant read endpoints (`src/auth.config.ts:7-31`).
- Session-authenticated route handlers use `requireUser()` or `requireAdmin()` from `src/lib/api.ts`; `requireAdmin()` checks only the global session role, not tenant membership (`src/lib/api.ts:24-35`).
- `/api/v1/*` handlers are excluded from the proxy and use API keys through `requireApiKey()` (`src/lib/v1.ts:31-50`). API-key principals contain `apiKeyId` and optional `userId`, but no tenant id or WABA/phone-number scope (`src/lib/api-keys.ts:31-48`).
- The WebSocket upgrade validates a NextAuth session cookie with `verifySessionToken()` (`src/lib/auth-token.ts:28-43`) inside `attachRealtime()` (`src/server/realtime.ts:64-93`).

### Authorization model

- `resolveTenantContext()` accepts a requested tenant id only as an access request, validates it, and verifies a persisted `TenantMembership` for the authenticated user (`src/lib/tenant/index.ts:31-57`).
- `assertTrustedTenantContext()` only accepts contexts produced by `resolveTenantContext()` (`src/lib/tenant/index.ts:60-63`).
- `createTenantMessagingRepository()` asserts trusted tenant context and filters contacts, conversations, and messages by `tenantId` (`src/lib/tenant/repository.ts:39-102`).
- ADR-0008 says global `ADMIN`/`AGENT` roles do not bypass tenant membership and service identities require separate authorization contracts (`docs/adr/0008-centralized-tenant-authorization.md:14-22`).
- Only the two tenant read endpoints currently use this centralized tenant authorization and tenant-scoped repository.

### Data ownership model

- `Tenant`, `TenantMembership`, `WabaAccount`, and nullable ownership columns exist as persistence foundation (`prisma/schema.prisma:74-130`).
- The schema comments state the foundation is not fully operational multi-tenancy (`prisma/schema.prisma:74,88,103`).
- `Contact`, `Conversation`, and `Message` can have nullable `tenantId` and are indexed by tenant where present (`prisma/schema.prisma:132-216`). Nullable ownership remains ambiguous for legacy rows.
- `WabaSettings` is a singleton row with id `default`, storing one global WABA/phone credential configuration (`prisma/schema.prisma:54-68`; `src/lib/settings.ts:16-31`).

## HTTP entry-point inventory

### Summary counts

| Classification | Count | Notes |
| --- | ---: | --- |
| PROTECTED | 2 | Tenant contact and tenant conversation reads. |
| PARTIAL | 10 | API-key or Meta/Flow-token protected, but no trusted tenant context or ownership mapping. |
| LEGACY | 34 | Session/admin-authenticated global data access or global auth/config management. |
| UNKNOWN | 1 | NextAuth delegated route. |
| **Total** | **47** | `src/app/api/**/route.ts` files. |

### Complete HTTP surface table

| Surface | Methods | Source file | Auth behavior | Tenant-sensitive data access | Classification | Evidence and risk |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/tenants/[tenantId]/contacts/[contactId]` | GET | `src/app/api/tenants/[tenantId]/contacts/[contactId]/route.ts` | `auth()` session required; `resolveTenantContext()` checks membership. | `tenantMessagingRepository.findContact()` filters by trusted tenant context. | PROTECTED | Tenant id is a request, not identity; membership checked before tenant-filtered read (`route.ts:37-81`, `repository.ts:39-45`). |
| `/api/tenants/[tenantId]/conversations/[conversationId]` | GET | `src/app/api/tenants/[tenantId]/conversations/[conversationId]/route.ts` | `auth()` session required; `resolveTenantContext()` checks membership. | `tenantMessagingRepository.findConversation()` filters conversation and contact ownership. | PROTECTED | Membership checked before tenant-filtered read (`route.ts:38-67`, `repository.ts:47-55`). |
| `/api/contacts` | GET, POST | `src/app/api/contacts/route.ts` | `requireUser()`. | `prisma.contact.findMany`, `findUnique`, `create` without tenant filter or tenant assignment. | LEGACY | Any authenticated user reaches global contact list/create path (`route.ts:5-42`). |
| `/api/contacts/[id]` | PATCH, DELETE | `src/app/api/contacts/[id]/route.ts` | PATCH `requireUser()`, DELETE `requireAdmin()`. | Updates/deletes contact by id without tenant ownership check. | LEGACY | Direct `prisma.contact.update/delete({ where: { id } })` (`route.ts:11-30`). |
| `/api/conversations` | GET, POST | `src/app/api/conversations/route.ts` | `requireUser()`. | Reads global conversations; POST uses global contact/conversation send path. | LEGACY | GET `prisma.conversation.findMany` has no tenant filter (`route.ts:8-35`). |
| `/api/conversations/[id]/messages` | GET, POST | `src/app/api/conversations/[id]/messages/route.ts` | `requireUser()`. | Reads/marks/sends messages by conversation id without tenant ownership check. | LEGACY | Fetches `conversation.findUnique({ where: { id } })`, reads messages by `conversationId`, and marks read (`route.ts:15-35`). |
| `/api/media/[messageId]` | GET | `src/app/api/media/[messageId]/route.ts` | `requireUser()`. | Reads message media by message id without tenant ownership check. | LEGACY | `prisma.message.findUnique({ where: { id: messageId } })` then streams media (`route.ts:7-28`). |
| `/api/templates` | GET, POST | `src/app/api/templates/route.ts` | GET `requireUser()`, POST `requireAdmin()`. | Reads/creates global templates. | LEGACY | `template.findMany` and `template.create` have no tenant/WABA scope (`route.ts:6-52`). |
| `/api/templates/[id]` | GET, PUT, DELETE | `src/app/api/templates/[id]/route.ts` | Session/admin route behavior. | Template operations by id; no tenant/WABA ownership scope observed. | LEGACY | File exists and belongs to global template management surface. |
| `/api/templates/[id]/submit` | POST | `src/app/api/templates/[id]/submit/route.ts` | Admin/session route behavior. | Submits template through global WABA configuration. | LEGACY | File exists under template management; submission is not tenant-scoped. |
| `/api/templates/sync` | POST | `src/app/api/templates/sync/route.ts` | Admin/session route behavior. | Synchronizes templates from global WABA config. | LEGACY | File exists under template management; sync is not tenant-scoped. |
| `/api/templates/upload-sample` | POST | `src/app/api/templates/upload-sample/route.ts` | Admin/session route behavior. | Uploads sample media through global WABA settings. | LEGACY | File exists under template management; no tenant context. |
| `/api/broadcasts` | GET, POST | `src/app/api/broadcasts/route.ts` | `requireAdmin()`. | Reads broadcasts; creates broadcast recipients from global contacts. | LEGACY | POST resolves audience via `prisma.contact.findMany` without tenant filter (`route.ts:36-68`). |
| `/api/broadcasts/[id]` | GET | `src/app/api/broadcasts/[id]/route.ts` | `requireAdmin()`. | Reads broadcast recipients and contact details globally. | LEGACY | Admin-only but no tenant scope; broadcast/contact data is tenant-sensitive. |
| `/api/settings` | GET, PUT | `src/app/api/settings/route.ts` | `requireAdmin()`. | Reads/writes singleton WABA credentials/configuration. | LEGACY | Global `getWabaConfig()`/`updateWabaConfig()` with singleton settings (`route.ts:12-49`, `settings.ts:16-31`). |
| `/api/settings/test` | POST | `src/app/api/settings/test/route.ts` | Admin/session route behavior. | Tests global WABA configuration. | LEGACY | File exists under global settings; no tenant context. |
| `/api/settings/flow-key` | POST | `src/app/api/settings/flow-key/route.ts` | Admin/session route behavior. | Updates global Flow key/configuration. | LEGACY | File exists under global settings; no tenant context. |
| `/api/apikeys` | GET, POST | `src/app/api/apikeys/route.ts` | `requireAdmin()`. | Lists/creates global API keys. | LEGACY | API keys have user linkage but no tenant scope (`route.ts:6-29`, `api-keys.ts:31-48`). |
| `/api/apikeys/[id]` | DELETE | `src/app/api/apikeys/[id]/route.ts` | `requireAdmin()`. | Revokes global API key by id. | LEGACY | Global admin operation; no tenant ownership dimension. |
| `/api/users` | GET, POST | `src/app/api/users/route.ts` | Admin/session route behavior. | Lists/creates users globally. | LEGACY | User management is global; tenant membership is not the authorization boundary here. |
| `/api/users/[id]` | PATCH, DELETE | `src/app/api/users/[id]/route.ts` | Admin/session route behavior. | Updates/deletes users globally. | LEGACY | User management is global; no tenant-scoped contract in this endpoint. |
| `/api/logs` | GET | `src/app/api/logs/route.ts` | `requireAdmin()`. | Reads all `ApiLog` or `WebhookEvent` rows. | LEGACY | `apiLog.findMany`/`webhookEvent.findMany` are global (`route.ts:12-39`). |
| `/api/webhook` | GET, POST | `src/app/api/webhook/route.ts` | Excluded from proxy; GET validates verify token, POST validates Meta signature if `appSecret` exists. | Persists webhook events and invokes global processing. | PARTIAL | Auth is service-signature based, not user/tenant membership; payload stored before processing (`route.ts:25-55`). Phone/WABA-to-tenant ownership is not established here. |
| `/api/whatsapp/flows/data` | POST | `src/app/api/whatsapp/flows/data/route.ts` | Excluded from proxy; validates Meta signature and encrypted Flow token. | Loads `FlowLaunch` by token hash and includes flow/contact. | PARTIAL | Strong endpoint-specific checks, but no tenant/WABA mapping or `TenantContext` (`route.ts:9-29`). |
| `/api/v1/messages` | POST | `src/app/api/v1/messages/route.ts` | Excluded from proxy; `requireApiKey()`. | Sends messages and creates/uses global contacts/conversations. | PARTIAL | API key auth exists, but key principal has no tenant scope; route imports global send/conversation helpers (`route.ts:23-53`, `api-keys.ts:31-48`). |
| `/api/v1/templates` | GET | `src/app/api/v1/templates/route.ts` | API key. | Reads approved templates globally. | PARTIAL | API-key protected but not tenant-scoped. |
| `/api/v1/broadcasts` | POST | `src/app/api/v1/broadcasts/route.ts` | API key. | Creates broadcast from global template/contact audience. | PARTIAL | `requireApiKey()` then `template.findFirst` and `contact.findMany` without tenant filter (`route.ts:23-52`). |
| `/api/v1/flows` | GET | `src/app/api/v1/flows/route.ts` | API key. | Reads published flows globally. | PARTIAL | API-key protected but not tenant-scoped. |
| `/api/v1/flows/[id]/launch` | POST | `src/app/api/v1/flows/[id]/launch/route.ts` | API key. | Launches a flow against global contact/flow records. | PARTIAL | API-key protected but not tenant-scoped. |
| `/api/v1/flow-launches/[id]` | GET | `src/app/api/v1/flow-launches/[id]/route.ts` | API key. | Reads flow launch state globally by id. | PARTIAL | API-key protected but not tenant-scoped. |
| `/api/v1/flow-submissions` | GET | `src/app/api/v1/flow-submissions/route.ts` | API key. | Reads flow submissions globally. | PARTIAL | API-key protected but not tenant-scoped. |
| `/api/v1/flow-submissions/[id]` | GET | `src/app/api/v1/flow-submissions/[id]/route.ts` | API key. | Reads one flow submission globally by id. | PARTIAL | API-key protected but not tenant-scoped. |
| `/api/v1/status` | GET | `src/app/api/v1/status/route.ts` | API key/status route behavior. | Status/config surface, not tenant-scoped. | PARTIAL | API v1 service identity has no tenant contract. |
| `/api/flows` | GET, POST | `src/app/api/flows/route.ts` | GET `requireUser()`, POST `requireAdmin()`. | Reads/creates flows globally. | LEGACY | `prisma.flow.findMany` has no tenant filter; `createLocalFlow` uses user id only (`route.ts:7-33`). |
| `/api/flows/[id]` | GET, PUT, DELETE | `src/app/api/flows/[id]/route.ts` | Session/admin route behavior. | Flow operations by global id. | LEGACY | File exists; no tenant endpoint contract. |
| `/api/flows/[id]/bindings` | GET, POST | `src/app/api/flows/[id]/bindings/route.ts` | Session/admin route behavior. | Flow connector bindings by global flow id. | LEGACY | File exists; no tenant context. |
| `/api/flows/[id]/clone` | POST | `src/app/api/flows/[id]/clone/route.ts` | Admin/session route behavior. | Clones global flow. | LEGACY | File exists; no tenant context. |
| `/api/flows/[id]/upload` | POST | `src/app/api/flows/[id]/upload/route.ts` | Admin/session route behavior. | Uploads global flow to WABA. | LEGACY | File exists; global WABA settings used by flow service. |
| `/api/flows/[id]/publish` | POST | `src/app/api/flows/[id]/publish/route.ts` | Admin/session route behavior. | Publishes global flow. | LEGACY | File exists; no tenant context. |
| `/api/flows/[id]/deprecate` | POST | `src/app/api/flows/[id]/deprecate/route.ts` | Admin/session route behavior. | Deprecates global flow. | LEGACY | File exists; no tenant context. |
| `/api/flows/sync` | POST | `src/app/api/flows/sync/route.ts` | Admin/session route behavior. | Syncs flows through global WABA config. | LEGACY | File exists; no tenant context. |
| `/api/flow-connectors` | GET, POST | `src/app/api/flow-connectors/route.ts` | Admin/session route behavior. | Global connector configuration. | LEGACY | File exists; connector config is not tenant-scoped. |
| `/api/flow-connectors/[id]` | DELETE | `src/app/api/flow-connectors/[id]/route.ts` | Admin/session route behavior. | Deletes global connector configuration. | LEGACY | File exists; no tenant context. |
| `/api/flow-submissions` | GET | `src/app/api/flow-submissions/route.ts` | `requireUser()`. | Reads flow submissions with launch/contact globally. | LEGACY | `flowSubmission.findMany` includes launch/contact without tenant filter (`route.ts:5-30`). |
| `/api/flow-submissions/[id]` | GET | `src/app/api/flow-submissions/[id]/route.ts` | `requireUser()`. | Reads one flow submission globally. | LEGACY | File exists; no tenant context. |
| `/api/flow-submissions/[id]/retry` | POST | `src/app/api/flow-submissions/[id]/retry/route.ts` | `requireAdmin()`. | Retries delivery for global flow submission. | LEGACY | Admin-only but no tenant scope. |
| `/api/auth/[...nextauth]` | GET, POST | `src/app/api/auth/[...nextauth]/route.ts` | Delegates to NextAuth handlers. | Authentication boundary, not tenant data access by itself. | UNKNOWN | The route exports handlers from `@/auth`; tenant isolation classification is not applicable from this file alone. |

## Non-HTTP and indirect entry points

| Surface / event type | Source file | Auth behavior | Authorization behavior | Data access behavior | Classification | Risk and evidence |
| --- | --- | --- | --- | --- | --- | --- |
| WebSocket upgrade `/ws` | `server.ts`; `src/server/realtime.ts`; `src/lib/auth-token.ts` | Session cookie decoded by `verifySessionToken()`. | No tenant membership check; user id is stored only as a client bucket. | `publish()` serializes event and sends to all connected sockets. | PARTIAL | Authenticated-only realtime exists, but fan-out is global (`src/server/realtime.ts:35-42`, `64-93`). Realtime events can carry message/contact/template payloads. |
| Realtime publishers | `src/lib/whatsapp/webhook.ts`; `src/lib/whatsapp/send.ts`; `src/lib/whatsapp/flow-submission.ts` | Publisher functions run inside server-side handlers/jobs. | No tenant-scoped channel selection observed. | Publishes message/status/template/flow events produced by global data paths. | PARTIAL | Events are not tenant-addressed; clients must not treat websocket as truth. |
| Meta webhook processing | `src/app/api/webhook/route.ts`; `src/lib/whatsapp/webhook.ts` | Verify token for GET; HMAC signature if app secret exists for POST. | Service identity is Meta signature, not tenant membership. | `processWebhook()` maps inbound messages/statuses to global settings/contact/conversation/message rows. | PARTIAL | Signature verification is present, but WABA/phone-number-to-tenant ownership is not resolved before writes. |
| Outbound sending | `src/lib/whatsapp/send.ts`; `src/lib/whatsapp/client.ts` | Called by authenticated routes, API-key routes, and background queue. | No trusted tenant context parameter. | `ensureConversation()` upserts by `waId`; `graphFetch()` uses singleton WABA config. | LEGACY | Global outbound routing can be ambiguous for multi-WABA (`send.ts:11-23`, `client.ts:35-48`, `settings.ts:16-31`). |
| Broadcast queue | `src/lib/whatsapp/broadcast.ts` | Triggered by admin/API-key HTTP routes. | No tenant context. | In-process `PQueue`; reads broadcast/template/recipients globally and sends through singleton config. | LEGACY | Queue is process-local and global (`broadcast.ts:10-28`, `34-40`). |
| Flow maintenance interval | `server.ts`; `src/lib/whatsapp/flow-submission.ts` | Runs inside server process. | No tenant context. | Periodic retry/expiry/retention cleanup across global flow data. | LEGACY | `server.ts` starts `runFlowMaintenance()` every minute (`server.ts:34-44`). |
| Graph API client | `src/lib/whatsapp/client.ts` | Uses stored access token from singleton settings. | No tenant/WABA account context passed. | Logs outbound API calls globally in `ApiLog`. | LEGACY | Central client is global by config (`client.ts:31-48`). |
| Tenant authorization helper and repository | `src/lib/tenant/index.ts`; `src/lib/tenant/repository.ts` | Requires authenticated principal supplied by caller. | Checks `TenantMembership`; no `ADMIN` bypass. | Filters selected contact/conversation/message reads by `tenantId`. | PROTECTED | Foundation is sound for current protected reads but not yet integrated system-wide. |

## Protection classifications and isolation gaps

### PROTECTED surfaces

1. `GET /api/tenants/[tenantId]/contacts/[contactId]`
2. `GET /api/tenants/[tenantId]/conversations/[conversationId]`
3. Tenant helper/repository when used with a trusted `TenantContext`.

Evidence supports tenant isolation for these surfaces only. They authenticate through session, authorize through persisted membership, and perform tenant-filtered reads. They do not establish isolation for legacy routes that still access the same entities.

### PARTIAL surfaces

- `/api/v1/*` routes authenticate by API key but API keys are not tenant-scoped.
- `/api/webhook` verifies Meta signature but does not map WABA/phone-number metadata to a tenant before processing.
- `/api/whatsapp/flows/data` validates signature/encryption/token but has no tenant context.
- WebSocket `/ws` authenticates users but broadcasts events globally.

### LEGACY surfaces

Most session/admin routes remain global. They use `requireUser()` or `requireAdmin()` and direct Prisma access without tenant filters. This preserves legacy single-installation compatibility but leaves alternate access paths around the new protected tenant reads.

### UNKNOWN surfaces

- `/api/auth/[...nextauth]` is delegated to NextAuth. It is an authentication surface, not a tenant data surface by itself. Tenant isolation is therefore not classified from that route file alone.

## Evidence-backed isolation gaps

### 1. Legacy contact, conversation, message, and media routes bypass protected tenant read endpoints

Observed behavior:

- `/api/contacts` lists and creates contacts globally (`src/app/api/contacts/route.ts:5-42`).
- `/api/conversations` lists conversations globally (`src/app/api/conversations/route.ts:8-35`).
- `/api/conversations/[id]/messages` reads thread messages and marks read by conversation id (`src/app/api/conversations/[id]/messages/route.ts:15-35`).
- `/api/media/[messageId]` streams media by message id (`src/app/api/media/[messageId]/route.ts:7-28`).

Risk:

- Cross-tenant confidentiality risk if tenant-owned records coexist with legacy routes before those routes adopt tenant-scoped repositories.
- Cross-tenant write risk for legacy mutation paths that update contacts, mark messages read, or send messages.

Confidence: **High**.

### 2. Realtime fan-out is authenticated but not tenant-isolated

Observed behavior:

- `attachRealtime()` accepts `/ws` connections after session-token verification (`src/server/realtime.ts:64-93`).
- `publish()` sends every event to every open socket across all authenticated users (`src/server/realtime.ts:35-42`).

Risk:

- Tenant-sensitive message, status, template, or flow events can be delivered to authenticated users outside the relevant tenant unless future work adds tenant-aware subscriptions or event channels.

Confidence: **High**.

### 3. Webhook inbound ownership is ambiguous

Observed behavior:

- `/api/webhook` validates the Meta signature when an app secret is configured and persists `WebhookEvent` (`src/app/api/webhook/route.ts:25-55`).
- Processing is delegated to `processWebhook()` and the active WABA config is the singleton `WabaSettings.default` (`src/lib/settings.ts:16-31`).
- Current schema permits nullable tenant ownership for messaging entities (`prisma/schema.prisma:132-216`).

Risk:

- Inbound `metadata.phone_number_id`/WABA identity is not yet resolved to `WabaAccount`/`Tenant`; inbound contacts, conversations, messages, and statuses can remain legacy/global or null-owned.

Confidence: **High** for missing tenant mapping in the inspected entry point; **Medium** for exact row ownership outcome because full processing details are distributed through helper functions.

### 4. Outbound routing is global

Observed behavior:

- `ensureConversation()` upserts contacts by `waId` and conversations by contact id, without tenant context (`src/lib/whatsapp/send.ts:11-23`).
- `graphFetch()` loads the singleton WABA config unless a config is explicitly supplied (`src/lib/whatsapp/client.ts:35-48`).
- `WabaSettings` is a singleton (`prisma/schema.prisma:54-68`).

Risk:

- Future multi-WABA routing cannot rely on current outbound helpers without explicit tenant/WABA/phone-number ownership context.

Confidence: **High**.

### 5. API-key surface is service-authenticated but not tenant-scoped

Observed behavior:

- API keys are verified by hash and return only `apiKeyId` and optional `userId` (`src/lib/api-keys.ts:31-48`).
- `/api/v1/broadcasts` uses API-key auth, then reads templates and contacts globally (`src/app/api/v1/broadcasts/route.ts:23-52`).

Risk:

- External consumers using a valid API key can access or trigger operations over global data until API keys gain tenant/resource scope or route-specific ownership checks.

Confidence: **High**.

### 6. Admin-only settings, logs, users, templates, flows, broadcasts are global by design today

Observed behavior:

- `requireAdmin()` checks global role only (`src/lib/api.ts:31-35`).
- Settings, logs, users, API keys, templates, flows, and broadcasts do not require `TenantContext`.

Risk:

- This preserves existing single-installation operational behavior, but it is not tenant isolation. Future bounded work must decide which admin surfaces remain installation-global and which become tenant/WABA-scoped.

Confidence: **High**.

## Risk priorities

1. **Legacy contact/conversation/message/media reads** — highest confidentiality risk because they expose core tenant-sensitive data through alternate paths.
2. **Legacy message/contact writes and outbound sends** — high cross-tenant write and routing ambiguity risk.
3. **Realtime fan-out** — high event confidentiality risk because websocket clients receive global events.
4. **Webhook inbound ownership** — high ownership ambiguity for future multi-WABA and tenant reconciliation.
5. **API-key `/api/v1` surface** — high external-integration risk because keys are not tenant-scoped.
6. **Broadcasts** — high write/blast-radius risk due to global audience selection.
7. **Settings/templates/flows/logs/admin surfaces** — medium risk; admin-only but currently installation-global.
8. **Flow encrypted data endpoint** — medium risk; strong Meta/Flow-specific checks exist, but tenant ownership is not modeled at the endpoint.

## Proposed bounded follow-up units

These are proposed units only; this document does not implement them.

1. **WA-01-05F — Tenant-scope legacy contact list/read routes**  
   Add tenant-aware list/detail access for contacts and keep legacy compatibility explicit.

2. **WA-01-05G — Tenant-scope conversation thread/message/media reads**  
   Route thread and media reads through tenant-scoped repositories and related ownership checks.

3. **WA-01-05H — Tenant-safe conversation writes and outbound send ownership checks**  
   Require trusted tenant context before sending or mutating conversation/contact state in tenant-aware paths.

4. **WA-01-05I — Tenant-aware realtime event channels**  
   Add tenant-scoped subscriptions and server-side event targeting; keep websocket as transport, not truth.

5. **WA-01-05J — API-key tenant/resource scope design and enforcement**  
   Define whether external API keys bind to tenant, WABA account, phone number, or installation-global integration role.

6. **WA-01-05K — Webhook inbound ownership mapping**  
   Map Meta `phone_number_id`/WABA metadata to `WabaAccount` and tenant before creating or updating tenant-owned records.

7. **WA-01-05L — Broadcast tenant boundary**  
   Constrain broadcast audiences, templates, and recipients by tenant/WABA ownership before multi-WABA routing.

8. **WA-01-05M — Admin/global surface policy**  
   Decide and document which settings, logs, users, API keys, templates, flows, and connector surfaces remain installation-global versus tenant-scoped.

## Remaining unknowns

- Exact row ownership outcomes inside all helper functions called by route handlers were not exhaustively traced beyond the security-relevant entry points above.
- The inventory does not prove exploitability; it classifies source-observed isolation posture.
- Production data shape is unknown and was not accessed.
- Historical `tenantId: null` rows remain a compatibility and ownership ambiguity until an approved backfill/transition unit addresses them.
- Multi-WABA routing semantics are not yet approved for implementation.

## Relationship to WA-01-06 and WA-01-07

This inventory should inform the next bounded tenant-isolation work before proceeding to broad Multi-WABA routing.

- **Before WA-01-06 Multi-WABA routing**, the project needs explicit ownership mapping for inbound webhooks, outbound send helpers, API keys, templates/flows, and broadcast audiences. Current singleton `WabaSettings.default` and global send helpers are not sufficient evidence for safe multi-WABA routing.
- **Before WA-01-07 broader realtime/async integration**, websocket fan-out and in-process queues need tenant-aware event contracts, idempotency/recovery boundaries, and explicit service-identity authorization contracts. ADR-0005 and ADR-0006 remain proposed and are not implemented by this inventory.

## Regression and no-change statement

This task is documentation only. It intentionally makes no changes to application code, tests, schema, migrations, runtime configuration, Docker artifacts, authentication, authorization, repositories, or production services.
