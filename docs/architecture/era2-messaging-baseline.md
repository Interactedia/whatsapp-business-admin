# ERA 2 — Messaging Baseline Architecture Report

**Task ID:** WA-ERA2-01-ARCHITECTURE-BASELINE  
**Status:** Baseline Verified  
**Date:** 2026-10-10  
**Scope:** Verified Architectural Baseline for Inbound/Outbound Messaging, Persistence Boundaries, Idempotency, and Tenant Isolation prior to Redis + BullMQ Introduction.

---

## 1. Verified Repository Architecture

The actual implementation of `whatsapp-business-admin` was directly inspected from repository evidence.

| Component / Layer | Specification / Technology | File / Evidence Reference |
|---|---|---|
| **Runtime & Framework** | Node.js `>=24 <25`, Next.js `^16.3.4` (App Router), TypeScript `^6.0.2` | `package.json`, `.nvmrc` |
| **Persistence Engine** | PostgreSQL 16 via Prisma ORM `^7.10.0` with `@prisma/adapter-pg` | `package.json`, `prisma/schema.prisma` |
| **Database Models** | `Tenant`, `TenantMembership`, `WabaAccount`, `PhoneNumber`, `Contact`, `Conversation`, `Message`, `WebhookEvent`, `Broadcast`, `BroadcastRecipient` | `prisma/schema.prisma` |
| **Authentication** | Auth.js / NextAuth `^5.0.0-beta.32` (session-based) + API Keys (SHA-256 hashed) | `src/auth.ts`, `src/lib/v1.ts`, `src/lib/tenant/index.ts` |
| **Realtime Dispatch** | Native WebSocket server (`ws ^8.21.3`) attached to HTTP server, using a `globalThis.__waRealtime` hub | `server.ts`, `src/server/realtime.ts` |
| **Async Execution** | In-process `p-queue ^9.3.3` (used solely for broadcasts; non-durable) | `src/lib/whatsapp/broadcast.ts` |
| **External WhatsApp Provider**| Meta WhatsApp Cloud API via `graphFetch` HTTP client | `src/lib/whatsapp/client.ts` |
| **Deployment Model** | Native Linux service (systemd-ready), **No Docker runtime dependency** | `AGENTS.md`, `docs/adr/0003-native-deployment.md` |

### 1.1 Dependency Verification for Queue Infrastructure
- `package.json` **does not** contain `bullmq`, `ioredis`, or `redis`.
- The only background queue present is in-memory `PQueue` in `src/lib/whatsapp/broadcast.ts` (`concurrency: 8, interval: 1000, intervalCap: 20`).
- Any process restart clears the in-memory queue, dropping ongoing broadcast jobs unless reconciled from database state.

---

## 2. Inbound Message Sequence & Lifecycle

### 2.1 Call Chain & Flow
The end-to-end inbound webhook path was traced through concrete code references:

```text
Meta WhatsApp Cloud API
  → POST /api/webhook (src/app/api/webhook/route.ts)
    1. Raw Body & Signature Extraction (req.text(), header x-hub-signature-256)
    2. Signature Verification (verifySignature against global appSecret or tenant WabaAccount.appSecret)
    3. Audit Persistence: prisma.webhookEvent.create(payloadJson, signatureValid)
    4. HTTP Response Handling:
       - If signature invalid: return HTTP 401
       - If signature valid: invoke processWebhook(body) inside try/catch
       - Catch block: on processing error, logs error and still returns HTTP 200 (prevents Meta retry storms)
  → processWebhook (src/lib/whatsapp/webhook.ts)
    5. Payload Decomposition (entry[] → changes[] → value)
    6. Event Routing:
       - value.messages → handleMessage(msg, value.metadata.phone_number_id)
       - value.statuses → handleStatus(st, value.metadata.phone_number_id)
       - value.message_template_id / event → handleTemplateStatus(value)
  → handleMessage (src/lib/whatsapp/webhook.ts)
    7. Tenant/WABA Resolution: resolveInboundPhoneNumber(metaPhoneNumberId)
       - Resolves PhoneNumber including wabaAccount -> resolves businessPhone.wabaAccount.tenantId
    8. Contact Resolution: prisma.contact.upsert({ where: { waId }, ... })
       - Updates profileName, lastInboundAt
    9. Conversation Resolution: prisma.conversation.upsert or create
       - Binds conversation to contactId, tenantId, and phoneNumberId
       - Updates lastInboundAt (drives 24h customer-service window)
   10. Inbound Media Download (if applicable): downloadInboundMedia(mediaObj.id, config)
       - Downloads from Meta Graph API, saves to local disk, returns mediaPath & mediaMime
   11. Idempotency Check: prisma.message.findUnique({ where: { waMessageId: msg.id } })
       - If exists: returns early with `dup ${msg.id}`
   12. Message Persistence: prisma.message.create({ ... })
       - direction: "IN", status: "RECEIVED", waMessageId: msg.id, tenantId
   13. Realtime Fan-out: publish({ type: "message:new", ... }, tenantId)
       - Delivers event to connected WebSocket clients filtered strictly by tenantId
   14. Fire-and-forget Visual Enrichment (if msg.type === "image" && mediaPath):
       - Triggers enrichImage(...) in background Promise (.then / .catch)
       - Updates message.payload asynchronously upon completion
```

---

## 3. Outbound Message Sequence & Lifecycle

### 3.1 Call Chains
Outbound messages originate from two distinct entry points:
1. **Operator Inbox UI**: `POST /api/tenants/:tenantId/conversations/:conversationId/messages` (`src/app/api/tenants/[tenantId]/conversations/[conversationId]/messages/route.ts`)
2. **External API v1**: `POST /api/v1/messages` (`src/app/api/v1/messages/route.ts`)

Both delegate to `sendMessage` in `src/lib/whatsapp/send.ts`.

```text
Operator Inbox / External API v1
  → Route Handler:
    1. Authentication & Context:
       - Inbox: Session via auth(), resolves TenantContext via resolveTenantContext(principal, tenantId)
       - API v1: API key hash check, resolves TenantContext via resolveApiKeyTenantContext(principal)
    2. Tenant Authorization & Scoping:
       - Inbox: findConversation ensures conversation belongs to authorized tenantId
       - API v1: startTenantConversation ensures contact & conversation belong to authorized tenantId
    3. Session Window Validation:
       - isWithinSessionWindow(conversation.lastInboundAt) evaluated for text/media
       - If > 24 hours, free-form text/media rejected with HTTP 403 (requires approved template)
    4. Media Upload (if applicable): uploadOutboundMedia / storeFromLink
  → sendMessage (src/lib/whatsapp/send.ts)
    5. Sender Config Resolution:
       - Loads conversation.phoneNumber.wabaAccount
       - Decrypts access token via decrypt(account.accessTokenEnc)
    6. Direct External Provider Call (Synchronous Side-Effect):
       - graphFetch(`/${phoneNumberId}/messages`, { method: "POST", body: buildPayload(...) })
       - If Meta returns non-200, throws WhatsAppApiError
    7. Optimistic Error Catching:
       - If graphFetch throws: persists Message with status="FAILED", errorJson=e.response, updates conversation, emits realtime event, and rethrows
    8. Message Persistence (Success Path):
       - prisma.message.create({
           direction: "OUT",
           status: "SENT",
           waMessageId: data.messages[0].id,
           tenantId: conversation.tenantId,
           conversationId, ...
         })
    9. Conversation Metadata Update:
       - prisma.conversation.update({ data: { lastMessageAt: now, lastPreview, unreadCount: 0 } })
   10. Realtime Notification:
       - publish({ type: "message:new", ... }, conversation.tenantId)
   11. HTTP Response: Returns serialized message with HTTP 201
```

---

## 4. Transaction and Durability Boundary Analysis

A critical analysis was conducted across every boundary where failures or process crashes could occur.

| Scenario / Boundary | Classification | Verified Repository Evidence & Failure Mechanism |
|---|---|---|
| **Raw Webhook Ingress vs Processing** | **Partially Protected** | `WebhookEvent` row is inserted before `processWebhook` runs (`route.ts:50`). However, if the process crashes during `processWebhook`, the unhandled event remains stored with status unprocessed, but **no retry mechanism** exists to pick it back up. |
| **Meta Inbound Ack vs DB Commit** | **Partially Protected** | Processing occurs before HTTP 200 is returned to Meta. However, errors are caught and swallowed (`route.ts:56-60`) to return HTTP 200, which avoids Meta spam retries but leaves failed processing orphaned without an automated recovery queue. |
| **Inbound Media Download vs Message Write** | **Unprotected** | `downloadInboundMedia` runs synchronously before `prisma.message.create` (`webhook.ts:198`). If media download times out or crashes, the message processing aborts or runs partially; no transaction wraps media fetch + message insert. |
| **Inbound Duplicate Delivery** | **Already Protected** | Database has `@unique` constraint on `Message.waMessageId` (`prisma/schema.prisma:287`). In addition, `handleMessage` checks `prisma.message.findUnique({ where: { waMessageId: msg.id } })` (`webhook.ts:215`) and early-returns `"dup <wamid>"`. |
| **Outbound Provider Call vs Local Persistence** | **Unprotected** (Dual-Write Failure Window) | `graphFetch` (Meta API) is called **before** `prisma.message.create` (`send.ts:153-176`). If the process crashes or DB becomes unavailable right after Meta accepts the message, Meta sends the message to the customer, but the local database has **no record of the message**. |
| **Outbound Duplicate Send on Client Retry** | **Unprotected** | There is no client-supplied idempotency key on outbound API or UI endpoints. If a client experiences an HTTP timeout and retries `POST /api/v1/messages`, Meta receives two requests and delivers the message twice. |
| **Broadcast Processing vs Process Restart** | **Unprotected** | `PQueue` stores broadcast jobs purely in memory (`broadcast.ts:18`). If the server restarts during a 10,000 recipient broadcast, queued sends are lost from memory. Only already persisted `BroadcastRecipient` statuses reflect progress. |
| **Delivery Status Out-of-Order Delivery** | **Partially Protected** | Meta can deliver status updates out of order (e.g. `READ` before `DELIVERED`). `handleStatus` (`webhook.ts:291-298`) blindly writes whatever status arrives (`prisma.message.update({ data: { status } })`), allowing a delayed `DELIVERED` webhook to overwrite `READ`. |

---

## 5. Idempotency Mechanisms Inventory

### 5.1 Existing Inbound Mechanisms
- **`Message.waMessageId`**: Unique constraint in PostgreSQL (`waMessageId String? @unique`).
- **Application Check**: `handleMessage` executes `prisma.message.findUnique({ where: { waMessageId: msg.id } })` prior to creating the message record.
- **`WebhookEvent`**: Stores raw payload and `signatureValid`, but has no unique event ID constraint from Meta (Meta does not supply an overall webhook batch ID, only individual message IDs `msg.id` and status IDs `st.id`).
- **Flow Submissions**: `recordFlowSubmission` associates submission data by `waMessageId`.

### 5.2 Outbound Idempotency Gaps
- Outbound requests **do not accept or generate** an idempotency key prior to invoking Meta's API.
- `Message` is created with `status: "PENDING"` only on the type enum level; in practice, `sendMessage` directly creates it as `status: "SENT"` with the returned Meta `wamid`.

---

## 6. Tenant and WABA Context Isolation

### 6.1 Current Enforcement Model
1. **TenantContext Contract**: Enforced via `assertTrustedTenantContext(context)` using a memory-safe `WeakSet<TenantContext>` in `src/lib/tenant/index.ts`.
2. **Inbound Webhook Resolution**:
   - Meta sends incoming events to a single webhook endpoint.
   - The recipient business phone is identified by `value.metadata.phone_number_id`.
   - `resolveInboundPhoneNumber(metaPhoneNumberId)` in `src/lib/tenant/waba.ts` queries `PhoneNumber` including `wabaAccount`.
   - This resolves the canonical `wabaAccount.tenantId`.
   - All created entities (`Contact`, `Conversation`, `Message`) are tagged with this verified `tenantId`.
3. **Outbound Authorization**:
   - Routes resolve caller's `TenantContext` from session or API key.
   - `findConversation` and `startTenantConversation` apply strict `{ tenantId: context.tenantId }` SQL filters.
   - `sendMessage` pulls credentials strictly from `conversation.phoneNumber.wabaAccount`.
4. **Realtime Isolation**:
   - WebSocket client connections record authorized `tenantId` upon token handshake.
   - `publish(event, targetTenantId)` drops the message if `targetTenantId` is null, or skips any connection where `conn.tenantId !== targetTenantId`.

---

## 7. Existing Test Coverage Baseline

The repository test suite was executed to verify the current health of tenant isolation and messaging behavior:
- **Total Test Files:** 36 test files in `test/`
- **Key Suites:**
  - `test/tenant-data-access.test.ts`
  - `test/tenant-http-access.test.ts`
  - `test/tenant-waba-routing.test.ts`
  - `test/tenant-conversation-http.test.ts`
  - `test/tenant-message-history-http.test.ts`
  - `test/signature-window.test.ts`
  - `test/realtime-tenancy.test.ts`
- **Status:** All existing unit and isolation tests compile and pass against the Prisma client.

---

## 8. Summary of Identified Risks for ERA 2 Implementation

1. **Dual-Write Vulnerability in Outbound Messaging:** Calling Meta before database commit risks ghost sends upon DB crash.
2. **In-Memory Volatility of Broadcasts:** `p-queue` must be migrated to BullMQ to ensure persistence across process restarts.
3. **Status Race Conditions:** Need a deterministic state machine transition rule for `MessageStatus` (`PENDING` → `SENT` → `DELIVERED` → `READ`) to reject stale status downgrades.
4. **Webhook Processing Backpressure:** Heavy inbound spikes (or slow image enrichment) currently execute on the HTTP request thread or unmanaged promises. Offloading to BullMQ queues will protect webhooks from timeouts.
