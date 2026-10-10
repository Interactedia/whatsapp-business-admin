# Tenant Isolation Remediation Plan

Task: `WA-01-05F`
Date: 2026-10-09
Status: remediation sequencing only; no application code, schema, migration, runtime, Docker, authentication, or authorization behavior changes.

## WA-ERA1-BATCH-C-R2 implementation note

This batch implements tenant-scoped API keys, tenant-bound realtime subscriptions, API key tenant gating for `/api/v1`, inbound/status webhook tenant resolution from business phone metadata, and tenant-scoped realtime publication. Legacy null-owned API keys are intentionally not backfilled. Templates/flows/broadcast definitions remain global schema surfaces and require a separately approved migration if full tenant ownership is needed there.

## Inventory baseline

This plan is derived from the accepted tenant API isolation inventory committed as `341f263 docs(tenancy): inventory tenant isolation surfaces`.

Baseline evidence read for this plan:

- `AGENTS.md`
- `docs/adr/README.md`
- `docs/adr/0008-centralized-tenant-authorization.md`
- `docs/TENANT_API_ISOLATION_INVENTORY.md`
- `docs/TENANT_AUTHORIZATION.md`
- `docs/TENANT_DATA_ACCESS.md`
- `docs/TENANT_HTTP_ACCESS.md`

Accepted inventory summary:

| Classification | Count | Meaning |
| --- | ---: | --- |
| PROTECTED | 2 | Tenant membership authorization and tenant-filtered data access are present for the inspected operation. |
| PARTIAL | 10 | Authentication, signature, token, or endpoint-specific checks exist, but isolation is not tied to a trusted `TenantContext`. |
| LEGACY | 34 | Existing session/admin/API-key behavior is global or single-installation oriented and not tenant-aware. This does not prove exploitability. |
| UNKNOWN | 1 | Source evidence is insufficient to classify tenant isolation safely. |
| Total HTTP handlers | 47 | `src/app/api/**/route.ts` files. |

Approved security architecture remains unchanged:

- Centralized application authorization; PostgreSQL RLS remains deferred.
- `TenantContext` is trusted only when returned by `resolveTenantContext(principal, requestedTenantId)` after persisted `TenantMembership` verification.
- Global `ADMIN` and `AGENT` roles do not bypass tenant membership.
- Tenant-scoped repositories enforce ownership in Prisma queries.
- Historical `tenantId: null` records are not tenant-accessible by default.
- Meta webhooks, workers, API keys, websocket clients, and integrations require explicit service-identity contracts; user membership alone is not their authorization model.

## Evidence-backed findings used

The following findings come from `docs/TENANT_API_ISOLATION_INVENTORY.md`. They are isolation gaps or incomplete migration evidence, not confirmed exploit claims.

### High-risk finding 1 — Legacy contact, conversation, message, and media routes bypass protected tenant read endpoints

| Field | Evidence |
| --- | --- |
| Entry points | `/api/contacts`, `/api/conversations`, `/api/conversations/[id]/messages`, `/api/media/[messageId]` |
| Source files | `src/app/api/contacts/route.ts`; `src/app/api/conversations/route.ts`; `src/app/api/conversations/[id]/messages/route.ts`; `src/app/api/media/[messageId]/route.ts` |
| Observed behavior | Contacts, conversations, thread messages, message read state, and media are read or mutated through global Prisma lookups keyed by ids or global collections. |
| Current classification | LEGACY |
| Tenant-sensitive entities | `Contact`, `Conversation`, `Message`, media payloads, read state. |
| Authentication mechanism | `requireUser()` for the listed legacy read/write paths. |
| Ownership boundary | `Contact.tenantId`, `Conversation.tenantId`, `Message.tenantId`, and parent ownership consistency established by tenant repositories for protected reads. |
| Existing protections | Two newer protected read routes exist: `GET /api/tenants/[tenantId]/contacts/[contactId]` and `GET /api/tenants/[tenantId]/conversations/[conversationId]`. |
| Missing guarantees | Legacy list/read/media/read-state paths do not require trusted `TenantContext`; null-owned and cross-tenant records are not denied through these paths by tenant-scoped repositories. |
| Dependencies | Tenant-aware identity resolution; tenant-scoped reads; tenant-scoped writes for read-state/send mutations; historical ownership reconciliation for `tenantId: null` compatibility decisions. |

### High-risk finding 2 — Legacy message/contact writes and outbound sends are globally routed

| Field | Evidence |
| --- | --- |
| Entry points | `/api/contacts`, `/api/contacts/[id]`, `/api/conversations`, `/api/conversations/[id]/messages`; outbound helpers used by routes and jobs. |
| Source files | `src/app/api/contacts/route.ts`; `src/app/api/contacts/[id]/route.ts`; `src/app/api/conversations/route.ts`; `src/app/api/conversations/[id]/messages/route.ts`; `src/lib/whatsapp/send.ts`; `src/lib/whatsapp/client.ts` |
| Observed behavior | Contacts can be created, patched, or deleted without tenant ownership checks; sends and conversation upserts are performed by helpers without trusted tenant context. `graphFetch()` can use singleton WABA settings. |
| Current classification | LEGACY |
| Tenant-sensitive entities | `Contact`, `Conversation`, `Message`, WABA credentials/config, outbound Graph API calls. |
| Authentication mechanism | `requireUser()` or `requireAdmin()` for legacy routes; helper calls inherit caller behavior. |
| Ownership boundary | Tenant, WABA account, and phone-number ownership must select the correct conversation/contact and outbound account. |
| Existing protections | Tenant authorization and read repositories exist, but write repositories and outbound account selection are not yet tenant-scoped. |
| Missing guarantees | No trusted tenant context for writes or sends; no explicit tenant/WABA/phone-number account selection; no guarantee that admin bypass is absent for future tenant-aware paths. |
| Dependencies | Tenant-aware identity resolution; tenant-scoped writes; outbound account selection; WABA/phone-number ownership; historical ownership reconciliation for existing rows. |

### High-risk finding 3 — Realtime fan-out is authenticated but not tenant-isolated

| Field | Evidence |
| --- | --- |
| Entry points | WebSocket upgrade `/ws`; realtime publishers. |
| Source files | `server.ts`; `src/server/realtime.ts`; `src/lib/auth-token.ts`; `src/lib/whatsapp/webhook.ts`; `src/lib/whatsapp/send.ts`; `src/lib/whatsapp/flow-submission.ts` |
| Observed behavior | `/ws` accepts authenticated session-token clients, but `publish()` sends every event to every open socket. Publishers emit message/status/template/flow events from global data paths. |
| Current classification | PARTIAL |
| Tenant-sensitive entities | Message, status, template, contact, flow, and submission event payloads. |
| Authentication mechanism | Session cookie decoded by `verifySessionToken()`. |
| Ownership boundary | Tenant membership and event tenant ownership must determine subscriptions and server-side fan-out targets. |
| Existing protections | WebSocket connections require authentication; websocket is already documented as transport, not truth. |
| Missing guarantees | No tenant membership check at subscription time; no tenant-scoped event channels; no server-side tenant targeting. |
| Dependencies | Realtime subscription isolation; event tenant metadata; tenant-aware publishers; prior ownership work for events produced by reads/writes/webhooks/sends. |

### High-risk finding 4 — Webhook inbound ownership is ambiguous

| Field | Evidence |
| --- | --- |
| Entry points | `/api/webhook`; webhook processing. |
| Source files | `src/app/api/webhook/route.ts`; `src/lib/whatsapp/webhook.ts`; `src/lib/settings.ts`; `prisma/schema.prisma` |
| Observed behavior | The route validates Meta verification/signature when configured, persists webhook events, then delegates processing. Active WABA config remains singleton-oriented; schema allows nullable tenant ownership for messaging rows. |
| Current classification | PARTIAL |
| Tenant-sensitive entities | Webhook events, contacts, conversations, messages, statuses, WABA account, phone number. |
| Authentication mechanism | Meta verify token for GET; HMAC signature for POST when app secret is configured. |
| Ownership boundary | `metadata.phone_number_id` and WABA identity must map to `WabaAccount` and tenant before tenant-owned writes. |
| Existing protections | Service-signature checks exist; endpoint is not a user-authenticated tenant route. |
| Missing guarantees | No inbound phone/WABA-to-tenant ownership resolution before creating or updating tenant-sensitive records. |
| Dependencies | WABA/phone-number ownership; inbound webhook routing; tenant-scoped writes; historical ownership reconciliation. |

### High-risk finding 5 — API-key surface is service-authenticated but not tenant-scoped

| Field | Evidence |
| --- | --- |
| Entry points | `/api/v1/messages`, `/api/v1/templates`, `/api/v1/broadcasts`, `/api/v1/flows`, `/api/v1/flows/[id]/launch`, `/api/v1/flow-launches/[id]`, `/api/v1/flow-submissions`, `/api/v1/flow-submissions/[id]`, `/api/v1/status` |
| Source files | `src/lib/api-keys.ts`; `src/app/api/v1/messages/route.ts`; `src/app/api/v1/templates/route.ts`; `src/app/api/v1/broadcasts/route.ts`; `src/app/api/v1/flows/route.ts`; `src/app/api/v1/flows/[id]/launch/route.ts`; `src/app/api/v1/flow-launches/[id]/route.ts`; `src/app/api/v1/flow-submissions/route.ts`; `src/app/api/v1/flow-submissions/[id]/route.ts`; `src/app/api/v1/status/route.ts` |
| Observed behavior | API keys are verified by hash and return `apiKeyId` plus optional `userId`; v1 routes perform global reads, sends, launches, or broadcasts without tenant/resource scope. |
| Current classification | PARTIAL |
| Tenant-sensitive entities | API keys, contacts, conversations, messages, templates, broadcasts, flows, launches, submissions, status/config data. |
| Authentication mechanism | `requireApiKey()`. |
| Ownership boundary | API keys must bind to a tenant, WABA account, phone number, or explicitly approved installation-global integration role. |
| Existing protections | API-key authentication exists. |
| Missing guarantees | Valid service credentials do not carry trusted tenant/resource scope; external operations can target global data until scoped. |
| Dependencies | API-key tenant/resource scope design; tenant-scoped reads/writes; outbound account selection; broadcast boundary. |

### High-risk finding 6 — Broadcast audience selection is global

| Field | Evidence |
| --- | --- |
| Entry points | `/api/broadcasts`, `/api/broadcasts/[id]`, `/api/v1/broadcasts`, broadcast queue. |
| Source files | `src/app/api/broadcasts/route.ts`; `src/app/api/broadcasts/[id]/route.ts`; `src/app/api/v1/broadcasts/route.ts`; `src/lib/whatsapp/broadcast.ts` |
| Observed behavior | Broadcast creation and delivery select templates, contacts, recipients, and queue work globally. |
| Current classification | LEGACY for session/admin routes and queue; PARTIAL for API-key v1 entry point. |
| Tenant-sensitive entities | Broadcasts, recipients, contacts, templates, messages, outbound account. |
| Authentication mechanism | `requireAdmin()` for application routes; `requireApiKey()` for v1; in-process queue after route trigger. |
| Ownership boundary | Audience, template, recipient, and outbound account must be tenant/WABA scoped. |
| Existing protections | Admin/API-key gates exist; queue is in-process and bounded by existing process. |
| Missing guarantees | No tenant-scoped audience selection or account routing; high blast-radius if tenant-owned data coexists. |
| Dependencies | Tenant-scoped reads/writes; outbound account selection; API-key tenant/resource scope for v1; WABA/template ownership. |

## Dependency graph

```text
Tenant membership + trusted TenantContext (existing foundation)
  -> Tenant-scoped read repositories (existing for contact/conversation/message reads)
      -> Legacy contact list/detail read remediation
      -> Conversation thread/message/media read remediation
          -> Tenant-safe read-state mutations
          -> Tenant-safe outbound send write paths
              -> Broadcast tenant boundary
              -> API-key send/broadcast enforcement

WABA/PhoneNumber ownership model (partially persisted; routing semantics not yet complete)
  -> Webhook inbound phone_number_id/WABA-to-tenant mapping
      -> Tenant-owned inbound writes/status reconciliation
      -> Realtime event tenant metadata from webhook events

Outbound account selection
  -> Tenant-safe conversation sends
  -> Broadcast delivery routing
  -> API-key outbound operations

Realtime subscription isolation
  <- Requires event tenant ownership from protected read/write/webhook/send paths
  -> Tenant-targeted websocket fan-out

API-key tenant/resource scope design
  -> API v1 read/send/flow/broadcast enforcement
  -> External integration compatibility policy

Historical ownership reconciliation
  -> Needed before granting access to nullable legacy rows
  -> Not required to deny null ownership in new tenant-aware reads
```

Dependency constraints:

- Do not make `ADMIN` a tenant-membership bypass for tenant-scoped endpoints.
- Do not grant tenant access to `tenantId: null` rows without an approved reconciliation/backfill unit.
- Do not require PostgreSQL RLS for these units; centralized application authorization is the accepted architecture.
- Do not start broad Multi-WABA routing until inbound ownership, outbound account selection, API-key scope, template/flow ownership, and broadcast audience boundaries are explicitly defined.
- Do not treat websocket delivery as truth; API reads remain the recovery source after disconnects.

## Priority ordering

1. **Legacy contact list/detail reads and contact mutation entry points** — first because contacts are the parent entity for conversation ownership and an alternate global access path already exists beside protected contact detail reads.
2. **Conversation thread, message, media, and read-state paths** — next because they carry the highest core confidentiality exposure and need parent contact/conversation ownership checks.
3. **Tenant-safe outbound sends and contact/conversation writes** — after read boundaries, because sends need trusted tenant context plus outbound account selection to avoid ambiguous writes.
4. **Realtime event channels** — after event-producing paths carry tenant ownership metadata, because fan-out cannot be safely targeted without event ownership.
5. **Webhook inbound ownership mapping** — high priority for Multi-WABA readiness, but it depends on approved WABA/phone-number ownership semantics and tenant-owned write behavior.
6. **API-key tenant/resource scope** — high external-integration risk, but requires a service-identity scope decision before enforcement.
7. **Broadcast tenant boundary** — high blast-radius; depends on tenant-scoped contacts/templates and outbound routing.
8. **Admin/global surface policy** — medium risk; decide which settings, logs, users, API keys, templates, flows, and connectors remain installation-global versus tenant-scoped.
9. **Flow encrypted data endpoint tenant ownership** — medium risk; endpoint has strong Meta/Flow-specific checks, but ownership modeling must be tied to FlowLaunch/Flow/WABA/tenant decisions.

Difference from the inventory ordering: this plan keeps the inventory's top risks but splits the first two remediation areas into smaller implementation units. It also moves API-key scope before broadcast enforcement because `/api/v1/broadcasts` cannot be tenant-safe until API keys carry a resource boundary.

## Bounded task sequence

### WA-01-05G — Tenant-scope legacy contact list/detail reads

| Field | Plan |
| --- | --- |
| Security objective | Ensure tenant-aware contact reads require verified membership and tenant-owned data access while preserving explicit legacy compatibility where approved. |
| Scope | `GET /api/contacts`; any existing contact detail/read behavior in `src/app/api/contacts/[id]/route.ts` if present; tenant repository support only if current read operations are insufficient. |
| Exclusions | Contact create/update/delete; outbound sends; historical backfill; schema changes; admin/global policy changes. |
| Dependencies | Existing `resolveTenantContext`; existing tenant contact repository; existing protected contact endpoint behavior. |
| Expected files | `src/app/api/contacts/route.ts`; `src/app/api/contacts/[id]/route.ts`; `src/lib/tenant/repository.ts` only if a missing bounded read helper is required; relevant tests under `test/`. |
| Required negative tests | Missing session returns 401; missing membership denied; cross-tenant contact denied; null-owned contact denied; global `ADMIN` without membership does not bypass tenant membership for tenant-aware path. |
| Required integration evidence | Existing protected contact endpoint still passes; legacy compatibility behavior is explicitly preserved or explicitly gated by an approved contract. |
| Completion criteria | Contact list/detail tenant-aware reads use trusted `TenantContext` and tenant-filtered repository queries; no unrelated write behavior changes. |
| Risk classification | High confidentiality risk. |

### WA-01-05H — Tenant-scope conversation thread, message, and media reads

| Field | Plan |
| --- | --- |
| Security objective | Ensure conversation messages and media reads require verified tenant ownership of message, conversation, and contact. |
| Scope | `GET /api/conversations/[id]/messages`; `GET /api/media/[messageId]`; read-only message listing/media retrieval repository helpers if needed. |
| Exclusions | Sending messages; marking messages read unless it remains coupled and cannot be separated safely; websocket changes; schema changes. |
| Dependencies | WA-01-05G; existing `findConversation`, `findMessage`, and `listConversationMessages` tenant repository rules. |
| Expected files | `src/app/api/conversations/[id]/messages/route.ts`; `src/app/api/media/[messageId]/route.ts`; `src/lib/tenant/repository.ts` only if existing helpers are insufficient; relevant tests under `test/`. |
| Required negative tests | Missing membership denied; cross-tenant conversation denied; cross-tenant message/media denied; null-owned message/conversation/contact denied; parent ownership mismatch denied. |
| Required integration evidence | Existing protected conversation endpoint still passes; message list pagination remains compatible for allowed same-tenant requests. |
| Completion criteria | Message and media reads are tenant-filtered through trusted context; denied cases are indistinguishable from missing records where appropriate. |
| Risk classification | High confidentiality risk. |

### WA-01-05I — Tenant-safe conversation writes and outbound send ownership checks

| Field | Plan |
| --- | --- |
| Security objective | Prevent tenant-aware contact/conversation/message mutations and sends from writing through global ownership paths. |
| Scope | `POST /api/conversations`; `POST /api/conversations/[id]/messages`; coupled read-state mutation if still present; `src/lib/whatsapp/send.ts` ownership contract. |
| Exclusions | API-key v1 sends; broadcast queue; webhook inbound processing; multi-WABA rollout; schema changes unless separately approved. |
| Dependencies | WA-01-05G; WA-01-05H; approved outbound account selection expectations; tenant-scoped write strategy. |
| Expected files | `src/app/api/conversations/route.ts`; `src/app/api/conversations/[id]/messages/route.ts`; `src/lib/whatsapp/send.ts`; tenant write helper/repository files if approved; relevant tests under `test/`. |
| Required negative tests | Cross-tenant conversation send denied; null-owned conversation denied for tenant-aware send; contact mutation across tenant denied; `ADMIN` without membership denied for tenant-aware path. |
| Required integration evidence | Allowed same-tenant send still creates or uses tenant-owned contact/conversation/message; Graph API account selection evidence is explicit or operation remains blocked pending account selection. |
| Completion criteria | Tenant-aware write/send paths cannot mutate cross-tenant or null-owned rows; legacy compatibility is explicit and not silently broadened. |
| Risk classification | High integrity/routing risk. |

### WA-01-05J — Tenant-aware realtime event channels

| Field | Plan |
| --- | --- |
| Security objective | Prevent authenticated websocket clients from receiving tenant-sensitive events for tenants where they lack membership. |
| Scope | `/ws` subscription authorization; event tenant addressing; `publish()` targeting; affected publishers. |
| Exclusions | Treating websocket as durable state; Redis/BullMQ; webhook relay; broad async redesign. |
| Dependencies | Event-producing paths must attach tenant ownership; WA-01-05G through WA-01-05I for core messaging events; service-event identity policy for webhook-generated events. |
| Expected files | `server.ts`; `src/server/realtime.ts`; `src/lib/auth-token.ts`; affected publisher call sites; relevant tests under `test/`. |
| Required negative tests | Authenticated non-member cannot subscribe to tenant channel; cross-tenant event is not delivered; missing tenant ownership is not broadcast globally; disconnect/reconnect recovers through API reads. |
| Required integration evidence | Same-tenant subscribed client receives expected event; existing authenticated websocket connection behavior remains compatible where explicitly allowed. |
| Completion criteria | Server-side fan-out is tenant-targeted; no global broadcast of tenant-sensitive payloads remains in tenant-aware event paths. |
| Risk classification | High confidentiality risk. |

### WA-01-05K — Webhook inbound ownership mapping

| Field | Plan |
| --- | --- |
| Security objective | Resolve Meta inbound webhook payloads to tenant-owned WABA/phone-number records before tenant-sensitive writes. |
| Scope | `/api/webhook` processing path; `processWebhook()` ownership lookup; inbound contact/conversation/message/status writes. |
| Exclusions | Webhook relay; Redis/BullMQ; production backfill; destructive migration; broad Multi-WABA rollout. |
| Dependencies | Approved WABA/phone-number ownership semantics; tenant-scoped write behavior; historical ownership reconciliation policy. |
| Expected files | `src/app/api/webhook/route.ts`; `src/lib/whatsapp/webhook.ts`; ownership lookup helpers; relevant tests under `test/`. |
| Required negative tests | Unknown phone number/WABA does not create tenant-owned rows silently; mismatched ownership denied or quarantined; invalid signature still denied; null ownership handling is explicit. |
| Required integration evidence | Valid Meta signature with known phone number maps to the expected tenant; status/message writes carry tenant ownership. |
| Completion criteria | Inbound writes have deterministic tenant ownership or explicit failure/quarantine behavior. |
| Risk classification | High ownership/integrity risk. |

### WA-01-05L — API-key tenant/resource scope design and enforcement

| Field | Plan |
| --- | --- |
| Security objective | Bind external API-key principals to an approved tenant/resource scope before v1 routes read or mutate tenant-sensitive data. |
| Scope | API-key principal contract; `/api/v1/*` route enforcement; compatibility behavior for existing keys. |
| Exclusions | New public API endpoints; webhook relay; production key migration without approved transition; broad integration redesign. |
| Dependencies | Decision on tenant vs WABA vs phone-number vs installation-global API-key scope; tenant-scoped reads/writes; outbound account selection for v1 sends. |
| Expected files | `src/lib/api-keys.ts`; `src/app/api/v1/**/route.ts`; schema/migration files only if separately approved; relevant tests under `test/`. |
| Required negative tests | Valid key without required tenant/resource scope denied for scoped route; cross-tenant resource denied; revoked/inactive key denied; credential value not leaked in errors/logs. |
| Required integration evidence | Same-scope API key can perform allowed operation; legacy key transition behavior is explicit and tested. |
| Completion criteria | v1 routes no longer rely on global API-key authentication alone for tenant-sensitive operations. |
| Risk classification | High external-integration risk. |

### WA-01-05M — Broadcast tenant boundary

| Field | Plan |
| --- | --- |
| Security objective | Ensure broadcast audiences, templates, recipients, and outbound delivery are tenant/WABA scoped. |
| Scope | `/api/broadcasts`; `/api/broadcasts/[id]`; `/api/v1/broadcasts`; `src/lib/whatsapp/broadcast.ts`. |
| Exclusions | Redis/BullMQ; durable queue redesign; webhook relay; unrelated template/flow admin policy. |
| Dependencies | WA-01-05I; WA-01-05L for v1 key scope; template/WABA ownership policy; outbound account selection. |
| Expected files | `src/app/api/broadcasts/route.ts`; `src/app/api/broadcasts/[id]/route.ts`; `src/app/api/v1/broadcasts/route.ts`; `src/lib/whatsapp/broadcast.ts`; relevant tests under `test/`. |
| Required negative tests | Cross-tenant contact audience denied; cross-tenant template denied; null-owned recipient excluded or denied per approved compatibility; API key outside scope denied. |
| Required integration evidence | Same-tenant broadcast selects only tenant-owned audience and uses approved outbound account. |
| Completion criteria | Broadcast creation, reads, and delivery cannot cross tenant/WABA ownership boundaries. |
| Risk classification | High blast-radius/write risk. |

### WA-01-05N — Admin/global surface policy

| Field | Plan |
| --- | --- |
| Security objective | Decide and enforce which admin surfaces remain installation-global and which require tenant/WABA scope. |
| Scope | Settings, logs, users, API keys, templates, flows, flow connectors, flow submissions, and related admin-only endpoints. |
| Exclusions | Implementing all surface changes in one rewrite; production operations; Docker; unrelated product features. |
| Dependencies | Product/security decision for installation-global vs tenant-scoped admin surfaces; WA-01-05L for API keys; WABA/template/flow ownership model. |
| Expected files | Specific files must be selected per sub-unit after policy decision; likely under `src/app/api/settings`, `src/app/api/logs`, `src/app/api/users`, `src/app/api/templates`, `src/app/api/flows`, `src/app/api/flow-connectors`, and `src/app/api/flow-submissions`. |
| Required negative tests | For each tenant-scoped surface: missing membership denied; cross-tenant denied; admin without membership denied. For installation-global surfaces: explicit admin-only behavior preserved. |
| Required integration evidence | Compatibility evidence for surfaces intentionally left global; tenant isolation evidence for surfaces moved to tenant/WABA scope. |
| Completion criteria | No admin surface has implicit tenant behavior; every surface is explicitly installation-global or tenant/WABA-scoped. |
| Risk classification | Medium policy/security risk. |

### WA-01-05O — Flow encrypted data endpoint tenant ownership

| Field | Plan |
| --- | --- |
| Security objective | Ensure Flow data exchange resolves FlowLaunch/Flow/Contact ownership consistently with tenant/WABA boundaries. |
| Scope | `/api/whatsapp/flows/data`; FlowLaunch lookup and response handling. |
| Exclusions | Generic workflow engine; webhook relay; full flow admin redesign. |
| Dependencies | WABA/phone-number ownership; Flow and FlowLaunch tenant ownership policy; webhook inbound mapping if Flow data is tied to inbound contacts. |
| Expected files | `src/app/api/whatsapp/flows/data/route.ts`; flow launch/data helpers; relevant tests under `test/`. |
| Required negative tests | Valid token for a launch whose ownership is missing or mismatched is denied or quarantined; invalid signature/encryption remains denied; cross-tenant FlowLaunch cannot expose data. |
| Required integration evidence | Valid same-tenant FlowLaunch returns expected data and preserves existing Meta/Flow-specific checks. |
| Completion criteria | Strong endpoint checks remain, and returned data is bounded by approved ownership rules. |
| Risk classification | Medium confidentiality/integration risk. |

## First recommended implementation

**Recommended next bounded implementation: `WA-01-05G — Tenant-scope legacy contact list/detail reads`.**

Reasoning:

- It has identifiable source paths: `src/app/api/contacts/route.ts` and `src/app/api/contacts/[id]/route.ts`.
- It addresses the first accepted risk priority without starting a mass authorization rewrite.
- It can reuse existing approved architecture: `auth()`, `resolveTenantContext()`, and tenant-scoped contact repository behavior.
- It can be tested with measurable negative cases: missing membership, cross-tenant contact, null-owned contact, and no implicit `ADMIN` bypass.
- It does not require unresolved WABA/phone-number routing, API-key scope, webhook ownership, Redis/BullMQ, or production data access.
- It can preserve legacy compatibility by making the tenant-aware path explicit and avoiding unapproved changes to unrelated admin/global surfaces.

The inventory used `WA-01-05F` as a proposed future implementation id for tenant-scoping legacy contact reads. This sequencing task also uses `WA-01-05F`. To avoid ambiguity in future packets, this plan assigns the first implementation unit the next id, `WA-01-05G`, and increments later units accordingly.

## Certification strategy for future remediation units

Each future implementation packet should define evidence for the boundary it changes. Passing more tests is not certification by itself; the evidence must prove the changed authorization rule.

Required certification dimensions:

| Dimension | Required evidence |
| --- | --- |
| Authorized same-tenant access | A principal with verified `TenantMembership` can access the tenant-owned resource or perform the tenant-scoped operation. |
| Missing membership denial | An authenticated user without membership is denied before tenant-sensitive data access or mutation. |
| Cross-tenant denial | A member of tenant A cannot read, mutate, subscribe to, or trigger operations for tenant B resources. |
| Null ownership handling | Records with missing historical ownership are denied or handled through an explicitly approved compatibility path; they are not silently granted. |
| No implicit ADMIN bypass | Global `ADMIN` role alone does not bypass tenant membership for tenant-scoped operations. |
| No credential leakage | API keys, access tokens, webhook secrets, Flow tokens, and media URLs are not exposed in errors, logs, responses, or test snapshots. |
| Runtime integration | Where relevant, route-level or service-level tests show the boundary works through the actual entry point, not only through helper functions. |
| Legacy compatibility | Existing protected endpoints and explicitly preserved legacy behavior continue to pass regression tests. |

Boundary-specific additions:

- **HTTP reads:** prove repository query filters include tenant and parent ownership checks.
- **HTTP writes:** prove writes cannot create or mutate rows outside the trusted tenant context.
- **Outbound sends:** prove account selection is explicit and tenant/WABA/phone-number aligned before Graph API calls.
- **Webhooks:** prove service signature validation remains intact and unknown ownership fails closed or is quarantined.
- **API keys:** prove key scope is part of the verified principal and is enforced by each v1 route.
- **Realtime:** prove server-side event targeting, not client filtering, prevents cross-tenant delivery.
- **Broadcasts:** prove audience, template, recipient, and outbound account are all within scope before enqueue/delivery.

## Acceptance conditions for this remediation plan

This planning unit is complete when:

- The accepted inventory baseline and commit are recorded.
- High-risk findings are traceable to inventory evidence and source paths.
- Dependency order is documented without circular dependencies.
- Bounded remediation tasks specify scope, exclusions, dependencies, files, tests, integration evidence, completion criteria, and risk.
- Exactly one first implementation unit is selected.
- Unsupported exploit claims are avoided.
- No architecture redesign is introduced.
- No application code, tests, schema, migration, Docker, runtime, or infrastructure files are changed.
- Required repository gates pass: `npm run lint`, `npm run test`, `npm run build`, `git diff --check`, and `git diff --staged --check`.

## Remaining unresolved questions

These are not blockers for the first recommended implementation, but they are blockers for later units unless separately decided:

1. What is the approved compatibility behavior for legacy `tenantId: null` production rows beyond fail-closed tenant-aware reads?
2. Which API-key scope model is approved: tenant, WABA account, phone number, installation-global integration role, or a combination?
3. What is the exact ownership mapping from Meta `phone_number_id` and WABA metadata to persisted `WabaAccount` and tenant records?
4. Which admin surfaces remain installation-global by product/security decision, and which become tenant/WABA-scoped?
5. How should existing singleton `WabaSettings.default` transition before Multi-WABA routing without breaking current deployments?
6. Which Flow, FlowLaunch, template, and connector records are tenant-owned versus installation-global?
7. What is the approved transition plan for existing API keys, broadcasts, templates, flows, and historical messaging rows?

## Relationship to WA-01-06

WA-01-06 should not proceed as broad Multi-WABA routing until the following are explicitly resolved or sequenced:

- Inbound webhook ownership mapping from Meta phone/WABA metadata to tenant-owned records.
- Outbound account selection for tenant-aware sends.
- API-key resource scope for external producers/consumers.
- Template, Flow, broadcast, and connector ownership rules.
- Compatibility and backfill plan for nullable historical ownership.

The first recommended unit, `WA-01-05G`, does not require those decisions because it can deny null/cross-tenant contact reads using existing tenant authorization and repository patterns.

## Relationship to WA-01-07

WA-01-07 realtime/async integration should depend on tenant-aware event contracts, not merely authenticated websocket connections.

Before WA-01-07 begins:

- Tenant-sensitive event producers should include trusted tenant ownership metadata.
- WebSocket subscriptions should be tenant-authorized server-side.
- Clients should recover truth through authenticated APIs after disconnects.
- ADR-0005 and ADR-0006 remain proposed and must not be treated as implementation authorization for Redis/BullMQ or webhook relay work.

## No-change statement

This task only creates `docs/TENANT_ISOLATION_REMEDIATION_PLAN.md`. It intentionally does not modify application code, tests, middleware, proxy behavior, authorization implementation, schema, migrations, Docker artifacts, runtime configuration, infrastructure, production data, or the proposed remediation units themselves.
