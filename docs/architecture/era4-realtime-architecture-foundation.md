# ERA 4 — Realtime Distributed Architecture Foundation

**Task ID:** WA-ERA4-00
**Status:** Architecture Documented
**Date:** 2026-10-12
**Certification commit:** `322da28` (ERA 3 FROZEN baseline)
**Document type:** Architecture inspection and foundation record
**Scope:** Read-only inspection + architectural documentation. No implementation changes.
**Layer:** layer-2 (execution) / layer-3-premium-value (complexity governance)

---

## 0. Executive Summary

This document establishes the architectural foundation for ERA 4 (Distributed Realtime) based on **repository-grounded inspection** of the existing codebase at commit `322da28`.

**Key findings:**

| Finding | Status |
|---------|--------|
| WebSocket infrastructure already exists | ✅ Implemented (`src/server/realtime.ts`, `src/hooks/use-realtime.ts`) |
| Single-process limitation | ⚠️ Documented — multi-instance NOT PROVEN |
| PostgreSQL as source of truth | ✅ Verified — no WebSocket/Redis state as truth |
| Tenant isolation in realtime | ✅ Implemented — session cookie + membership verification |
| BullMQ exists and is separate from Pub/Sub | ✅ Verified — conceptual separation maintained |
| Redis Pub/Sub not introduced | ✅ Not yet implemented |

**Critical gap:** The existing WebSocket hub is single-process only. Multi-instance deployments require a Redis Pub/Sub fan-out layer.

---

## 1. Repository AS-IS Inventory

### 1.1 WebSocket Realtime Infrastructure (EXISTING)

#### Server-side Hub (`src/server/realtime.ts`)

| Property | Value |
|----------|-------|
| Package | `ws` (WebSocketServer) |
| Storage | `globalThis.__waRealtime` singleton |
| Tenant isolation | Per-connection `tenantId` bound at upgrade |
| Auth method | NextAuth v5 JWT cookie decoded server-side |
| Re-validation interval | 60 seconds |
| Connection lifecycle | `setInterval` revalidates session + membership |

**Hub capabilities:**
- `publish(event, tenantId)` — tenant-scoped delivery (fail-closed on null tenant)
- `publishGlobal(event)` — all connected clients (for non-tenant surfaces)
- Connection tracking via `Set<ConnectionInfo>`
- WebSocket upgrade handler at `/ws?tenantId=...`

**Security model (verified from source):**
1. `tenantId` extracted from URL query param at upgrade
2. Session cookie verified via `verifySessionToken()`
3. `tenantMembership` checked for `userId + tenantId` + `user.active === true`
4. 401/403 rejection before WebSocket handshake completes
5. 60-second revalidation loop closes connection on revoked membership

#### Client Hook (`src/hooks/use-realtime.ts`)

| Property | Value |
|---------|-------|
| Transport | Native WebSocket API |
| Reconnect | Exponential backoff (500ms * 2^retry, max 6) |
| Tenant binding | Propagated via URL param `/ws?tenantId=...` |
| Handler ref | Kept current via `useRef` (no stale closures) |

#### Inbox Integration (`src/app/(app)/inbox/inbox-client.tsx`)

```typescript
// Lines 78-87 (verified from source)
useRealtime(tenantId || null, (msg) => {
  if (msg.type.startsWith("message:")) {
    qc.invalidateQueries({ queryKey: ["conversations", tenantId] });
    // Invalidate open thread if affected
    const p = msg.payload as { conversationId?: string };
    if (p.conversationId && p.conversationId === activeId) {
      qc.invalidateQueries({ queryKey: ["thread", tenantId, activeId] });
    }
  }
});
```

**Pattern:** Events trigger React Query cache invalidation. Client reconstructs state via API, not from event payload.

### 1.2 Current publish() Call Sites (9 total)

| File | Line | Event Type | Context |
|------|------|------------|---------|
| `webhook.ts` | 286 | `message:new` | Inbound message stored in DB |
| `webhook.ts` | 313 | `message:image-enriched` | Image enrichment async result |
| `webhook.ts` | 367 | `message:status` | Status webhook delivery |
| `send.ts` | 247 | `message:new` | Outbound message sent (success) |
| `send.ts` | 254 | `message:new` | Outbound message sent (failure) |
| `outbound/handler.ts` | 394 | (TBD) | Outbound handler |
| `outbound/handler.ts` | 514 | (TBD) | Outbound handler |
| `outbound/handler.ts` | 536 | (TBD) | Outbound handler |
| `flow-submission.ts` | 37 | `flow:submission` | Flow form submission |

**All calls verified to use `publish(event, tenantId)` with tenant-scoped delivery.**

### 1.3 Authentication & Authorization (EXISTING)

#### Session Token Verification (`src/lib/auth-token.ts`)

- Decodes Auth.js v5 JWE tokens
- Supports both dev (`authjs.session-token`) and production (`__Secure-authjs.session-token`) cookie names
- Returns `{ userId, role }` from decoded JWT `sub` claim
- Diagnostics logged without leaking credentials

#### Tenant Authorization (`src/lib/tenant/index.ts`)

```typescript
// resolveTenantContext: verified from source
async function resolveTenantContext(principal, requestedTenantId) {
  // 1. Validates both userId and tenantId
  // 2. Queries tenantMembership.findUnique({ userId, tenantId })
  // 3. Verifies user.active === true
  // 4. Returns TenantContext with membershipId
}
```

**Invariant preserved:** Tenant context derivation uses DB membership lookup, never trusts client-provided `tenantId` without server-side verification.

### 1.4 Redis Infrastructure (EXISTING)

#### Redis Client (`src/lib/redis/`)

| Component | File | Status |
|-----------|------|--------|
| Configuration | `config.ts` | Lazy loading, bounded retries |
| Connection | `client.ts` | Singleton via `globalThis.__waRedis` |
| Health check | `health.ts` | PING with timeout |
| Public API | `index.ts` | Re-exports |

**Key constraint:** `maxRetriesPerRequest: 3` — NOT compatible with BullMQ blocking operations.

#### BullMQ Infrastructure (`src/lib/queue/`)

| Component | File | Status |
|-----------|------|--------|
| Configuration | `config.ts` | Queue names, job options |
| Connection | `connection.ts` | Separate connection with `maxRetriesPerRequest: null` |
| Factory | `factory.ts` | Queue instantiation |
| Worker | `worker.ts` | Worker with error capture |
| Events | `events.ts` | QueueEvents lifecycle |
| Inspection | `inspection.ts` | Operational monitoring |
| Lifecycle | `lifecycle.ts` | Graceful shutdown |
| Public API | `index.ts` | Clean exports |

**Queue names defined:**
- `wa-webhook-inbound`
- `wa-message-outbound`
- `wa-status-reconciliation`
- `wa-broadcast-dispatch`

**Separation maintained:** BullMQ uses separate connection from Redis singleton. Pub/Sub not introduced.

### 1.5 Mutation Paths for Conversations/Messages/Status

#### Inbound Message Flow (webhook.ts)

```
1. Meta POST /api/webhook
2. Signature validation (signatureValid)
3. Raw payload stored in WebhookEvent
4. Prisma transaction:
   a. upsert/create Conversation
   b. upsert/create Contact
   c. create Message
   d. addCanonicalEvent (ERA 3)
5. DB commit (atomic)
6. publish({ type: "message:new" }, tenantId)  ← AFTER commit
```

#### Inbound Status Flow (webhook.ts)

```
1. Meta POST /api/webhook (status update)
2. Prisma transaction:
   a. update Message.status
   b. addCanonicalEvent (ERA 3)
3. DB commit (atomic)
4. publish({ type: "message:status" }, tenantId)  ← AFTER commit
```

#### Outbound Message Flow (send.ts)

```
1. create message in DB (status: PENDING)
2. API call to Meta WhatsApp Cloud API
3. On success: update Message (status: SENT, waMessageId)
4. DB update
5. publish({ type: "message:new" }, tenantId)  ← AFTER update
```

**Pattern verified:** All `publish()` calls occur **after** DB transaction commits. No event is published before state is durable.

### 1.6 Client State Recovery

**Current behavior (verified from inbox-client.tsx):**
- WebSocket events trigger `queryClient.invalidateQueries()`
- Client refetches from API endpoints
- No state reconstructed from event payload alone
- React Query handles caching and background refetch

**Gap identified:** No explicit reconnect/sync handshake. Client relies on cache invalidation + refetch.

---

## 2. Source of Truth Definition

### 2.1 Authority Hierarchy

| Layer | Role | Justification |
|-------|------|---------------|
| **PostgreSQL** | **Authoritative system of record** | Durable, ACID-compliant, tenant-isolated |
| **BullMQ + Redis** | **Async execution and durable retry** | Job state in Redis, but outcome committed to PostgreSQL |
| **WebSocket hub** | **Ephemeral notification transport** | In-memory only, lost on process restart |
| **Redis Pub/Sub** | **Future: ephemeral fan-out only** | Not introduced yet; never state |
| **Browser cache** | **UI optimization, not authoritative** | Invalidated on reconnect |

### 2.2 Invariant Enforcement

```typescript
// Verified from realtime.ts line 45-47
publish(event: RealtimeEvent, targetTenantId: string | null) {
  // Fail closed: tenant-owned events with unresolved tenant are never delivered.
  if (!targetTenantId) return;
  // ...
}
```

**Invariant 1:** `publish()` fails closed on null/undefined tenantId.
**Invariant 2:** No WebSocket/Pub/Sub message contains credentials or full message payloads that bypass API authorization.
**Invariant 3:** All state mutations are committed to PostgreSQL before `publish()` is called.

---

## 3. Conceptual Component Responsibilities

### 3.1 PostgreSQL

| Responsibility | Boundary |
|----------------|----------|
| Durable state | Conversations, Messages, Contacts, Users, Settings |
| Tenant isolation | All tenant-owned resources scoped by `tenantId` |
| Authorization enforcement | `tenantMembership` lookups verify access |
| Audit trail | CanonicalEvent tables (ERA 3) |
| Transactional outbox | `OutboxEvent` for durable outbound (ERA 2) |

**NOT responsible for:**
- Realtime fan-out
- Connection state
- Ephemeral notifications

### 3.2 Redis

| Responsibility | Boundary |
|----------------|----------|
| BullMQ job storage | Queues, jobs, metrics |
| BullMQ connection management | Separate from application Redis client |
| Health monitoring | `checkRedisHealth()` for ops |

**NOT responsible for:**
- Application state (never stores conversation/message data)
- Pub/Sub fan-out (not introduced)

### 3.3 BullMQ

| Responsibility | Boundary |
|----------------|----------|
| Async execution | Webhook processing, outbound sends |
| Retry logic | Exponential backoff, bounded attempts |
| Job deduplication | Job IDs prevent duplicate processing |
| Worker concurrency | Configurable per queue |

**Separation from Pub/Sub:**
- BullMQ = **Durable queue with execution semantics** (at-least-once, ordered within queue)
- Redis Pub/Sub = **Ephemeral fire-and-forget notification** (at-most-once, no persistence)

**These are conceptually different and must remain separate.**

### 3.4 Redis Pub/Sub (FUTURE)

| Responsibility | Boundary |
|----------------|----------|
| Multi-instance fan-out | Broadcast Hub events to all process instances |
| Connection notification | Notify other instances of state changes |
| Presence tracking | Optional: track which instances serve which tenants |

**NOT responsible for:**
- State storage
- Message persistence
- Exactly-once delivery guarantees

### 3.5 WebSocket Server

| Responsibility | Boundary |
|----------------|----------|
| Connection management | WebSocket upgrade, lifecycle |
| Client authentication | Session cookie + membership verification |
| Tenant scoping | Per-connection `tenantId` binding |
| Event dispatch | Fan-out to connected clients |
| Authorization revalidation | 60-second periodic check |

**NOT responsible for:**
- State storage
- Event persistence
- Cross-tenant delivery (fail-closed)

### 3.6 Next.js Application/API

| Responsibility | Boundary |
|----------------|----------|
| API routes | REST endpoints for client queries |
| DB mutations | All state changes through Prisma |
| Realtime publication | `publish()` after DB commits |
| Client hydration | Initial state via API |

**NOT responsible for:**
- WebSocket server lifecycle (handled by custom server.ts)
- Pub/Sub infrastructure

### 3.7 Browser/Client

| Responsibility | Boundary |
|----------------|----------|
| WebSocket connection | `useRealtime` hook manages lifecycle |
| State reconstruction | Fetches from API on event + on reconnect |
| UI rendering | React + React Query |

**NOT authoritative for:**
- State truth
- Tenant context (derived from authenticated session)

---

## 4. Conceptual Flow: Committed Mutation → Client Update

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. CLIENT → API: HTTP POST/PATCH                                   │
│    (authenticated via session/API key)                              │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. API HANDLER                                                      │
│    - Validates authorization (tenantMembership lookup)              │
│    - Executes Prisma transaction                                    │
│    - Commits to PostgreSQL (ATOMIC)                                │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. AFTER COMMIT: publish(event, tenantId)                           │
│    - Event has { type, payload }                                    │
│    - Payload is minimal: { conversationId, messageId, status }     │
│    - NOT full message content (avoids duplication)                 │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 4a. SINGLE-INSTANCE: Hub delivers to matching tenant connections   │
│                                                                      │
│ 4b. MULTI-INSTANCE (FUTURE): Hub → Redis Pub/Sub → All instances │
│     → Each instance's Hub delivers to local connections            │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 5. CLIENT: useRealtime handler receives event                       │
│    - Invalidates relevant React Query cache                        │
│    - Triggers background refetch from API                           │
│    - UI updates with fresh data from PostgreSQL via API            │
└─────────────────────────────────────────────────────────────────────┘
```

**Key properties:**
- Events carry **signals/deltas**, not full state
- Client **always refetches** from authoritative API
- PostgreSQL is consulted on reconnect, not event log

---

## 5. Reconnect & Resynchronization Strategy

### 5.1 Current Behavior

**Reconnect (verified from use-realtime.ts):**
- Exponential backoff: `500ms * 2^retry` (max 6 retries)
- After reconnect: client receives `connected` event
- No explicit sync handshake currently implemented

**Resync:**
- `queryClient.invalidateQueries()` triggers background refetch
- React Query's `refetchInterval: 30_000` on conversation list provides periodic sync
- No "catch-up" of missed events during disconnect

### 5.2 TO-BE Strategy (ERA 4 roadmap)

```
┌─────────────────────────────────────────────────────────────────────┐
│ ON RECONNECT:                                                        │
│ 1. Client sends WebSocket upgrade with session cookie               │
│ 2. Server verifies session + membership (existing behavior)          │
│ 3. Client sends { type: "sync", payload: { lastEventId?, since? } }│
│ 4. Server responds with:                                            │
│    a. Events since timestamp (from canonical event log)             │
│    b. OR current conversation/message state snapshot                │
│ 5. Client merges events, reconciles with local cache               │
│ 6. UI reflects authoritative state                                 │
└─────────────────────────────────────────────────────────────────────┘
```

**Recovery sources (in order of preference):**
1. CanonicalEvent table (ERA 3) — durable event log with timestamps
2. Conversation + Message tables — current state
3. Periodic poll fallback (30s) — already implemented

**Guarantee:** No permanent state loss from dropped events. PostgreSQL is always authoritative.

---

## 6. Authentication & Authorization Boundary

### 6.1 WebSocket Upgrade Flow (VERIFIED)

```
Client                        Server
  │                              │
  │──── WS /ws?tenantId=X ──────▶│
  │                              │ 1. Parse tenantId from URL
  │                              │ 2. Extract session cookie
  │                              │ 3. verifySessionToken(cookie)
  │                              │    └── Returns { userId, role }
  │                              │ 4. prisma.tenantMembership.findUnique({
  │                              │      where: { userId_tenantId }
  │                              │    })
  │                              │    └── Verifies user.active === true
  │                              │
  │◀── 101 Switching Protocols ──│ (or 401/403 on failure)
  │                              │
  │──── { type: "connected" } ──▶│
```

### 6.2 Tenant Isolation in Realtime

**Principle:** A connection is bound to exactly ONE `tenantId` at upgrade time.

```typescript
// From realtime.ts: ConnectionInfo
type ConnectionInfo = {
  ws: WebSocket;
  userId: string;
  tenantId: string;  // ← Bound once, never changed
  cookie: string;
  revalidate: ReturnType<typeof setInterval>;
};

// publish() filters by tenantId
publish(event, targetTenantId) {
  for (const info of hub.connections) {
    if (info.tenantId !== targetTenantId) continue;  // ← Tenant isolation
    info.ws.send(data);
  }
}
```

**Cross-tenant prevention:**
- `tenantId` comes from URL param, but is re-verified against DB at upgrade
- `publish(event, null)` fails closed (no delivery)
- `publishGlobal()` only for non-tenant surfaces (e.g., template status)

### 6.3 ADMIN Role Limitations

**Finding:** `ADMIN` role grants application-level permissions but does NOT bypass tenant membership.

```typescript
// From auth-token.ts:122
return { userId: decoded.sub, role: (decoded as { role?: string }).role || "AGENT" };
```

**Verified from realtime.ts:129-137:**
```typescript
const membership = await prisma.tenantMembership.findUnique({
  where: { userId_tenantId: { userId: session.userId, tenantId } },
  select: { id: true, user: { select: { active: true } } },
});
if (!membership || !membership.user.active) {
  // 403 Forbidden — ADMIN without membership is rejected
}
```

**Invariant preserved:** ADMIN role requires corresponding `tenantMembership` to access tenant-scoped realtime.

---

## 7. Multi-Instance Deployment Implications

### 7.1 Current Single-Process Limitation

**Finding (verified from ARCHITECTURE_BASELINE_REPORT.md line 107):**
> Multi-process propagation: NOT PROVEN — single-process WebSocketServer only

**Current architecture:**
```
[HUB on globalThis.__waRealtime]
         │
         ├── Instance A: API routes write to DB, call publish()
         │              └── Hub delivers to local connections
         │
         └── Instance B: (no awareness of Instance A's connections)
```

**Problem:** If a message is sent via Instance A, connected clients on Instance B do NOT receive the event.

### 7.2 TO-BE Multi-Instance Architecture (ERA 4 roadmap)

```
                    ┌─────────────────────────────────────┐
                    │           Redis Pub/Sub             │
                    │         (Fan-out channel)          │
                    └─────────────────────────────────────┘
                      │                    │
                      ▼                    ▼
              ┌───────────┐        ┌───────────┐
              │ Instance A │        │ Instance B │
              │  (Hub)    │        │  (Hub)    │
              └───────────┘        └───────────┘
                 │   │                │   │
                 ▼   ▼                ▼   ▼
           [Client 1] [Client 2]  [Client 3] [Client 4]
```

**Implementation requirement (ERA 4-02):**
```typescript
// Each Hub instance subscribes to Redis Pub/Sub channel
// On message: Hub delivers to local connections matching tenantId
```

### 7.3 Redis Pub/Sub Channel Design (IMPLEMENTED — WA-ERA4-02)

| Channel | Purpose | Subscriber mode |
|---------|---------|-----------------|
| `wa:realtime:tenant:<tenantId>` | Tenant-scoped events (messages, status) | PSUBSCRIBE `wa:realtime:*` (one subscription per Hub covers all tenants) |
| `wa:realtime:global` | Non-tenant events (template status) | SUBSCRIBE (exact) |

**Why PSUBSCRIBE for tenants:** tenants are dynamic — a single Hub cannot predict which tenants will connect. One pattern subscription covers every tenant channel that gets created. Global events are an exact SUBSCRIBE because there is exactly one global channel.

**Envelope (internal — never crosses the WebSocket boundary):**
```typescript
type RealtimeEnvelope = {
  origin: string;                // stable per-process instanceId of the publisher
  tenantId: string | null;       // null ⇒ global event
  event: { type: string; payload: unknown };  // the existing RealtimeEvent, unchanged
};
```

**Loop prevention (echo protection):** the publisher records its own `instanceId` in `origin`. The subscriber ignores every message whose `origin` matches the local `instanceId`. The publisher already delivered locally, so re-delivering the echo would double-send. The integration test `realtime-fanout.test.ts` proves this end-to-end with two real Hub instances against a real Redis.

**No-republish invariant:** the subscriber's inbound path calls `deliverRemote()` which only writes to local WebSockets. It never calls `publish()` or `publishToRedis()`. That is what prevents loops. The integration test verifies the publisher client's `publish` count stays at 0 on the receiving instance.

### 7.4 Redis Client Lifecycle

The adapter (`src/lib/realtime/distribution.ts`) uses a **dedicated pair of ioredis clients** that live alongside the existing BullMQ client (`src/lib/redis/client.ts`). ioredis cannot run normal commands on a connection in subscribe mode, so subscriber and publisher MUST be separate connections. The BullMQ connection is not touched.

| Client | Used for | Mode | Reconnect |
|--------|----------|------|-----------|
| `publisher` | `PUBLISH` to channels | normal | ioredis auto-retry |
| `subscriber` | `PSUBSCRIBE wa:realtime:*` and `SUBSCRIBE wa:realtime:global` | subscribe | ioredis auto-retry; resubscribes on reconnect |

Both clients are stored on `globalThis.__waRealtimePubSub` so Next's separate module graph and the custom server see the same adapter instance. `initRealtimeFanout()` in `src/server/realtime.ts` is called once from `server.ts` after `attachRealtime()`. It is idempotent: a second call rebinds the message handler but does not create new clients.

`shutdownRealtime()` (extended in WA-ERA4-02 from synchronous to async) now also calls `shutdownRealtimeDistribution()` which `quit()`s both clients and clears the state. This is the single teardown seam for the whole realtime layer.

### 7.5 Failure Semantics and Known Limitations

| Failure | Behavior | Recovery |
|---------|----------|----------|
| Redis temporarily disconnected | Publisher `publish` rejects, logged, returns false. Local delivery is unaffected. | ioredis auto-reconnects; new publishes work. Events published while Redis was down are **lost** for peer instances. |
| Subscriber reconnect | ioredis re-issues PSUBSCRIBE/SUBSCRIBE automatically. Existing handler bindings survive because they live on the same client object. | Verified by integration test F. |
| Malformed envelope | Logged, dropped, subscriber continues. | No automatic remediation; the publisher side is expected to be correct. |
| Server shutdown | `shutdownRealtime()` quits both clients and clears state. | Re-init on next boot. |
| Duplicate message on the wire | Possible during reconnect window. The envelope does not carry a deduplication token; dedup is the responsibility of the client (cache invalidation + refetch) and PostgreSQL (authoritative). | Not addressed here. |

**Documented limitations (intentional, by design):**

1. **At-most-once delivery.** Redis Pub/Sub does not retain messages. A peer instance that is disconnected when an event is published will not receive it. Recovery is the responsibility of the **client reconnect/resync work** planned for a later ERA 4 unit — not this one.
2. **No replay.** Subscribers cannot request historical events. The same rule applies.
3. **No exactly-once guarantee.** A duplicate publish on the wire (e.g. during reconnect) is delivered twice. The Hub already de-duplicates at the local level via the existing `connections` Set; the client is expected to refetch authoritative state from PostgreSQL on reconnect.
4. **No persistent state in Redis.** Redis Pub/Sub is transport only. The existing `__waRedis` (BullMQ) and the new `__waRealtimePubSub` (Pub/Sub) are conceptually and physically isolated.
5. **No presence tracking.** This packet does not introduce presence or fan-in.
6. **No backpressure.** A slow subscriber that cannot keep up is at the mercy of the broker's client-output-buffer. For the current publish rates this is acceptable; revisit if a real incident shows the buffers hitting their limit.

---

## 8. Risks & Mitigations

### 8.1 Ordering Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Events arrive out of order | Medium | Client uses timestamp + optimistic UI; authoritative state from API |
| Stale status overwrites newer | Low | Status webhook has `if (msg.status !== status)` guard (webhook.ts:348) |

**Invariant:** No event ordering guarantee required. Client always reconciles via API.

### 8.2 Duplicate Delivery Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Network retry causes duplicate publish | Low | Event handlers are idempotent (invalidate + refetch) |
| Redis Pub/Sub redelivery on reconnect | Low | Deduplication via event ID or timestamp window |

**Invariant:** WebSocket delivery is at-least-once, not exactly-once. Client refetch handles duplicates.

### 8.3 Dropped Notification Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Event lost during publish | Medium | PostgreSQL is authoritative; client refetches on reconnect |
| Client offline during burst | Medium | 30s polling provides eventual consistency |
| Redis Pub/Sub miss on instance crash | Medium | Event committed to DB before publish; reconnect triggers sync |

**Invariant:** Dropped events never cause permanent state inconsistency. PostgreSQL + periodic poll guarantee eventual sync.

### 8.4 Stale Client Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Client disconnected but cache shows old data | Medium | 60s revalidation + invalidate on reconnect |
| Browser tab backgrounded | Low | React Query handles background refetch |

---

## 9. BullMQ vs Pub/Sub Separation

### 9.1 BullMQ (Queue Processing)

| Property | Value |
|----------|-------|
| Purpose | Durable async execution |
| Semantics | At-least-once, ordered within queue |
| State | Job state in Redis, outcome in PostgreSQL |
| Retry | Exponential backoff, bounded attempts |
| Example | `wa-webhook-inbound`, `wa-message-outbound` |

### 9.2 Redis Pub/Sub (FUTURE - Ephemeral Notification)

| Property | Value |
|----------|-------|
| Purpose | Multi-instance fan-out |
| Semantics | At-most-once, fire-and-forget |
| State | No persistence; message lost if no subscriber |
| Retry | None; relies on periodic sync |
| Example | `wa:realtime:{tenantId}` |

**Conceptual boundary:**

```
BullMQ = "DO this job, retry if it fails, report outcome"
Pub/Sub = "TELL connected clients this happened" (no guarantee)
```

**They serve different purposes and must not be mixed.**

---

## 10. ERA 4 Implementation Roadmap

### 10.1 Unit Structure

| Unit | Task ID | Title | Description |
|------|---------|-------|-------------|
| 1 | WA-ERA4-01 | WebSocket Baseline | Extend existing hub with multi-instance Pub/Sub fan-out |
| 2 | WA-ERA4-02 | Distributed Realtime Infrastructure | Redis Pub/Sub subscription, channel design |
| 3 | WA-ERA4-03 | Authentication & Tenant Isolation | Enhanced WebSocket auth, faster revocation |
| 4 | WA-ERA4-04 | Realtime Event Contracts | Event schema, type safety, versioning |
| 5 | WA-ERA4-05 | Conversation/Message Sync | Sync protocol, reconnect handshake |
| 6 | WA-ERA4-06 | Delivery/Read Receipts | Status event contracts, optimistic UI |
| 7 | WA-ERA4-07 | Unread State | Unread count sync, badge updates |
| 8 | WA-ERA4-08 | Multi-Agent Coordination | Assignment events, operator presence |
| 9 | WA-ERA4-09 | Presence & Recovery | Connection state, graceful degradation |
| 10 | WA-ERA4-10 | Observability | Metrics, logging, error tracking |
| 11 | WA-ERA4-11 | Load & Failure Testing | Stress testing, chaos scenarios |
| 12 | WA-ERA4-CERT | ERA 4 Certification | Final certification and freeze |

### 10.2 Dependencies

```
WA-ERA4-01 ──┬── Requires: ADR-0005 (Redis/BullMQ) accepted
              │
              └── Enables: All subsequent ERA 4 units

WA-ERA4-02 ─── Requires: WA-ERA4-01 (Pub/Sub design)
              └── Enables: Multi-instance support

WA-ERA4-05 ─── Requires: WA-ERA4-02 + WA-ERA4-04
              └── Enables: WA-ERA4-06, WA-ERA4-07

WA-ERA4-CERT ─ Requires: All WA-ERA4-01..11
```

### 10.3 NOT Included in ERA 4

| Item | Rationale |
|------|----------|
| Presence (online/offline indicators) | Future enhancement, not blocking |
| Typing indicators | Already documented (docs/architecture/whatsapp-typing-indicator.md) but not implemented |
| Multi-device sync | Meta platform limitation |
| End-to-end encryption | Not applicable to WhatsApp Cloud API |

---

## 11. Findings & Decisions Preserved

### 11.1 Confirmed Invariants

| # | Invariant | Verified |
|---|-----------|----------|
| 1 | PostgreSQL is authoritative source of truth | ✅ No state in WebSocket/Redis |
| 2 | All publish() calls occur AFTER DB commit | ✅ Verified in all call sites |
| 3 | Tenant isolation enforced at upgrade + periodic | ✅ Session + membership check |
| 4 | ADMIN requires membership for tenant access | ✅ 403 on missing membership |
| 5 | BullMQ and Pub/Sub are separate | ✅ No Pub/Sub introduced |
| 6 | Events carry signals, not full state | ✅ Payload: { conversationId, status } |
| 7 | ERA 1/2/3 FROZEN | ✅ Baseline at 322da28 |

### 11.2 Gaps Identified

| Gap | Impact | Resolution Path |
|-----|--------|-----------------|
| Single-process WebSocket hub | Multi-instance clients miss events | WA-ERA4-01, WA-ERA4-02 |
| No reconnect sync handshake | Missed events on long disconnect | WA-ERA4-05 |
| No presence tracking | Cannot show online/offline | Future enhancement |
| No event deduplication | Duplicate events possible | WA-ERA4-04 (event IDs) |
| Revocation latency up to 60s | Stale connection after membership removal | WA-ERA4-03 characterised the window; push invalidation deferred to a future packet (requires separate architecture decision) |

### 11.3 No Conflicts with Frozen ERAs

**Finding:** The existing WebSocket implementation was introduced during ERA 2/3 but is NOT documented as frozen. It coexists with the ERA 3 FROZEN boundary (66eb3f1) which covers:
- Webhook relay and fan-out
- Transactional outbox
- Delivery reliability
- Idempotency

**Conclusion:** WebSocket realtime infrastructure is NOT part of the ERA 3 FROZEN boundary. ERA 4 may extend it.

---

## 11.4 Authentication, Authorization & Tenant Isolation Boundaries (WA-ERA4-03)

WA-ERA4-03 audited the existing realtime layer against the packet's
authorization invariants. The findings below are evidence-based — each
row is backed by a regression test in `test/realtime-security-regression.test.ts`
or `test/integration/realtime-fanout.test.ts`.

### Authentication Boundary

| Property | Implementation | Evidence |
|----------|----------------|----------|
| Cookie parsing | `parseCookies()` in `src/lib/auth-token.ts` | `test/realtime-cookie-parsing.test.ts` (pre-existing) |
| Token verification | `verifySessionToken()` via `next-auth/jwt` JWE decode | `test/realtime-cookie-parsing.test.ts` |
| Diagnostic redaction | Cookie-name presence only; never token bytes or session contents | `src/lib/auth-token.ts:90-99` (gated on `NODE_ENV !== "test"`) |
| Missing AUTH_SECRET | Returns null + logs `missing_secret` diagnostic | `src/lib/auth-token.ts:101-105` |
| Decode failure | Returns null + logs `decode_failed` diagnostic | `src/lib/auth-token.ts:124-135` |
| Upgrade rejection | 400 (bad URL) / 401 (no session) / 403 (no membership) | `src/server/realtime.ts:181-211` |
| HMR passthrough | Non-`/ws` upgrades are not consumed | `src/server/realtime.ts:172` |

### Tenant Authorization Boundary

| Property | Implementation | Evidence |
|----------|----------------|----------|
| Membership query | `prisma.tenantMembership.findUnique({ where: { userId_tenantId }, include: { user: { select: { active } } } })` | `src/server/realtime.ts:198-201` |
| `user.active` gate | Hard reject if `!membership.user.active` | `src/server/realtime.ts:202` |
| ADMIN role | **Not** consulted for WS auth — membership is the only gate | `test/realtime-security-regression.test.ts:ADMIN bypass attempt` |
| Client `tenantId` | Treated as a requested scope, NOT as authorization | `src/server/realtime.ts:181-186, 198-201` |
| Connection binding | `tenantId` field on `ConnectionInfo` is set from the validated server-side membership context | `src/server/realtime.ts:243` |
| Identity drift | Cookie revalidation checks `session.userId === userId` | `src/server/realtime.ts:235` |

### Connection Lifecycle (Revalidation)

| Property | Value | Evidence |
|----------|-------|----------|
| Interval | 60,000 ms (60 s) | `REVALIDATE_INTERVAL_MS` constant + `src/server/realtime.ts:241` |
| Verifications per tick | (1) `verifySessionToken(cookie)` (2) `prisma.tenantMembership.findUnique()` (3) `membership.user.active` (4) `session.userId === userId` | `src/server/realtime.ts:226-237` |
| Failure response | `ws.close(4403, "Unauthorized")` | `src/server/realtime.ts:236, 239` |
| Maximum demonstrated revocation window | **60 seconds** (one revalidation interval) | `test/realtime-security-regression.test.ts:characterizes the maximum revocation window` |
| Exception safety | Try/catch in async block; failure closes connection (fail-closed) | `src/server/realtime.ts:238-240` |
| Timer cleanup | `clearInterval(info.revalidate)` in `cleanup()` | `src/server/realtime.ts:251-256` |
| Double-cleanup guard | `let cleaned = false` short-circuit | `src/server/realtime.ts:250-256` |

### Local Delivery Authorization

| Property | Implementation | Evidence |
|----------|----------------|----------|
| Tenant filter | `if (info.tenantId !== tenantId) continue;` | `src/lib/realtime/local-delivery.ts:40` |
| Source of tenant | `targetTenantId` from `publish()`, NOT from client | `src/server/realtime.ts:63-79` |
| Fail-closed on null | `if (!targetTenantId) return;` | `src/server/realtime.ts:65` |
| Send error isolation | try/catch per connection, continues iteration | `src/lib/realtime/local-delivery.ts:42-49` |
| ReadyState guard | Only sends to `OPEN` (1) connections | `src/lib/realtime/local-delivery.ts:43-45` |
| Global delivery | Broadcasts to every connection regardless of tenant | `src/lib/realtime/local-delivery.ts:54-79` |

### Distributed Delivery (Redis Pub/Sub)

| Property | Implementation | Evidence |
|----------|----------------|----------|
| Envelope shape | `{ origin: string, tenantId: string \| null, event: { type, payload } }` | `src/lib/realtime/distribution.ts:8-13` |
| Channel naming | `wa:realtime:tenant:<tenantId>`, `wa:realtime:global` | `src/lib/realtime/distribution.ts:5-6` |
| Tenant-scoped pattern | `psubscribe("wa:realtime:tenant:*")` for fan-in | `src/lib/realtime/distribution.ts:225` |
| Loop prevention | `if (env.origin === state.instanceId) return;` | `src/lib/realtime/distribution.ts:228` |
| Envelope validation | `decodeEnvelope()` rejects missing/wrong-type fields | `src/lib/realtime/distribution.ts:271-294` |
| Malformed envelope | Logged + dropped, never throws to caller | `src/lib/realtime/distribution.ts:227` |
| At-most-once | Pub/Sub is fire-and-forget; no retention | `src/lib/realtime/distribution.ts:21` |
| Publisher failure isolation | `publishToRedis()` returns boolean; never throws | `src/lib/realtime/distribution.ts:151-167` |

### Global Event Authorization Boundary

`publishGlobal()` is reserved for surfaces that are NOT tenant-owned in
the current schema (e.g. template status). The implementation comment
explicitly warns: *"Never carry tenant message payloads through this
path."* A regression test verifies that `publishGlobal` reaches every
local connection regardless of tenant — this is the documented
semantics, not a defect. Any future global event that contains
tenant-owned data must be reviewed against this invariant.

### Trust Boundaries

| Trust boundary | Trusted? | Notes |
|----------------|----------|-------|
| WebSocket client → `/ws` upgrade | **Untrusted** | Cookie is verified; tenantId is requested scope, not auth |
| Browser-sent message payloads | **Untrusted** | Not consumed (the client is a subscriber, not a producer) |
| Redis Pub/Sub channel | **Trusted** | Only the application writes; envelope validates shape but trusts the producer's tenantId assignment |
| PostgreSQL | **Authoritative** | Membership and `user.active` are the source of truth |
| `process.env.AUTH_SECRET` | **Required** | Missing secret returns null on every verification |

### Remaining Limitations & Future Work

| Limitation | Impact | Trigger |
|------------|--------|---------|
| Maximum revocation window = 60 s | Revoked session/membership continues to receive events for up to 60 s | Decision required: push-based invalidation (separate packet) |
| Session-only authentication | No API key path on WebSocket | If an external system needs to subscribe, a separate authentication path is required |
| Loop prevention is instance-scoped | If two instances share an `instanceId` (operator error), a publisher's echo could be delivered twice | Operational discipline; not a code defect |
| Global events bypass tenant filter | A `publishGlobal` event reaches ALL connected operators | Documented and constrained; future global event additions must not carry tenant data |

---

## 12. References

### 12.1 Source Files Inspected

| File | Purpose |
|------|---------|
| `src/server/realtime.ts` | WebSocket hub implementation |
| `src/hooks/use-realtime.ts` | Client WebSocket hook |
| `src/app/(app)/inbox/inbox-client.tsx` | Inbox integration |
| `server.ts` | Custom server + WebSocket attachment |
| `src/lib/auth-token.ts` | Session token verification |
| `src/lib/tenant/index.ts` | Tenant authorization |
| `src/lib/redis/config.ts` | Redis configuration |
| `src/lib/queue/config.ts` | BullMQ configuration |
| `src/lib/whatsapp/webhook.ts` | Inbound mutation + publish |
| `src/lib/whatsapp/send.ts` | Outbound mutation + publish |
| `prisma/schema.prisma` | Data model |
| `test/realtime-tenancy.test.ts` | Tenant isolation tests |
| `docs/ARCHITECTURE_BASELINE_REPORT.md` | Prior architecture inspection |

### 12.2 Frozen Artifacts

| Artifact | Reference |
|----------|-----------|
| ERA 3 certification | `docs/architecture/era3-final-certification.md` |
| Baseline commit | `322da28` |
| Frozen code boundary | `66eb3f1` |

---

## 13. Acceptance Gate Results

| Gate | Requirement | Result |
|------|-------------|--------|
| Document exists | `docs/architecture/era4-realtime-architecture-foundation.md` | ✅ Created |
| AS-IS inventory | Realtime mechanisms documented | ✅ 9 publish() sites verified |
| TO-BE architecture | Multi-instance design defined | ✅ Pub/Sub fan-out outlined |
| PostgreSQL as authority | Explicitly defined | ✅ Section 2 |
| Ephemeral transport | Redis Pub/Sub and WebSocket defined as transport | ✅ Section 3.4, 3.5 |
| BullMQ/Pub/Sub separation | Conceptually distinct | ✅ Section 9 |
| Reconnect/resync strategy | Documented | ✅ Section 5 |
| Tenant-scoped auth | Boundary defined | ✅ Section 6 |
| Multi-instance implications | Documented | ✅ Section 7 |
| Risk analysis | Ordering, duplication, dropped, stale | ✅ Section 8 |
| ERA 4 roadmap | Sequential units defined | ✅ Section 10 |
| No code changes | git diff verification required | ⏳ Pending |
| No schema changes | prisma/schema.prisma unchanged | ⏳ Pending |
| Frozen ERAs unmodified | ERA 1/2/3 unchanged | ⏳ Pending |

---

## 14. WA-ERA4-04 — Canonical Event Inventory & Contract Hardening

**Task ID:** WA-ERA4-04
**Status:** Implemented
**Scope:** Internal contract hardening, regression tests, documentation. No public protocol change.

### 14.1 Canonical Event Inventory

The realtime system emits a closed, positive set of known event types. Unknown event types are still allowed through the wire (forward compatibility), but the catalog is the authoritative list for validation.

| Event Type | Scope | Producer(s) |
|-----------|-------|-------------|
| `message:new` | tenant | `webhook.ts:286`, `send.ts:247`, `send.ts:254`, `outbound/handler.ts:394`, `outbound/handler.ts:514`, `outbound/handler.ts:536` |
| `message:status` | tenant | `webhook.ts:367` |
| `message:image-enriched` | tenant | `webhook.ts:313` |
| `flow:submission` | tenant | `flow-submission.ts:37` |
| `template:status` | global | `webhook.ts:406` (via `publishGlobal`) |

Consumer side: `src/hooks/use-realtime.ts` (single WebSocket client consumer).

### 14.2 Wire Contract (Public, Unchanged)

The on-the-wire event shape is exactly:

```typescript
{ type: string; payload: unknown }
```

No new required public fields were introduced by WA-ERA4-04. Existing clients continue to parse the same JSON. The internal `RealtimeMessage` type in `use-realtime.ts` mirrors this contract.

### 14.3 Internal Redis Envelope (Unchanged)

```typescript
{
  origin: string;          // instanceId of the publishing process
  tenantId: string | null; // null for global, bound tenant otherwise
  event: { type: string; payload: unknown };
}
```

The envelope is validated at the decode boundary (`decodeEnvelope`) and at the Hub's publish path. WA-ERA4-04 adds a SCOPE validator that rejects envelopes whose `tenantId` contradicts the event's known scope.

### 14.4 New Validators (Internal, Additive)

Two new internal modules were added:

- `src/lib/realtime/events.ts` — the canonical event catalog. Exports `TENANT_EVENT_TYPES`, `GLOBAL_EVENT_TYPES`, `ALL_KNOWN_EVENT_TYPES`, `scopeForEventType`, `isKnownEventType`, `isRealtimeEvent`, and `EVENT_PRODUCER_MAP`.
- `src/lib/realtime/contracts.ts` — `validateEnvelopeScope`, `validatePayloadShape`, `validateEnvelope`. These are additive; they accept unknown event types (open wire contract) and only tighten validation for known types.

The Hub's `publish()` now rejects global event types (logged + dropped). The Hub's `publishGlobal()` now rejects tenant event types (logged + dropped). This is a fail-closed guard against accidental scope mismatches at producer call sites.

### 14.5 Tests

Two new test files, both deterministic (no I/O, no Redis, no WebSockets):

- `test/realtime-contracts.test.ts` — catalog invariants, producer/consumer mapping, scope validation, payload validation, wire-format preservation.
- `test/realtime-serialization-roundtrip.test.ts` — encode/decode round-trip for every canonical event type, malformed input rejection, scope/payload validation after round-trip.

The real-Redis integration test in `test/integration/realtime-fanout.test.ts` remains the authoritative proof for cross-process serialization.

### 14.6 Compatibility & Limitations

- ✅ All existing event names preserved.
- ✅ All existing payload keys preserved.
- ✅ All existing producers continue to work without code changes.
- ✅ All existing consumers (e.g. `useRealtime`) continue to parse the same JSON.
- ✅ `publish()` and `publishGlobal()` signatures preserved.
- ✅ Redis envelope structure preserved.
- ⚠️ WA-ERA4-04 adds a fail-closed guard: a known-global event passed to `publish()` is dropped (logged). This is additive defensive behavior; no existing producer hits this path.

### 14.7 Future Extension Rules

To add a new event type without breaking compatibility:

1. Add the type to `TENANT_EVENT_TYPES` or `GLOBAL_EVENT_TYPES` in `src/lib/realtime/events.ts`.
2. Add the payload shape to the discriminated union.
3. Update the producer/consumer map.
4. Update the section 14.1 table.
5. Add a regression test in `test/realtime-contracts.test.ts`.
6. NEVER remove or rename existing entries. NEVER add new required wire fields.

---

*Section 14 added by WA-ERA4-04. Earlier sections remain at their original baseline; they document the architecture foundation, not the hardened contract.*

---

## 15. WA-ERA4-06 — Delivery/Read Receipts Concurrency Guarantees

**Task ID:** WA-ERA4-06
**Status:** Documented
**Scope:** Verify and harden the canonical status reconciliation path under concurrent PostgreSQL transactions; preserve the existing public wire contract.

### 15.1 Actual PostgreSQL Concurrency Guarantees

The canonical status reconciliation lives in
`src/lib/whatsapp/status/reconciliation.ts` and is invoked by the
BullMQ status worker for every webhook whose payload contains a
`statuses[]` entry. The transaction runs under PostgreSQL's
default isolation level, `READ COMMITTED`.

**Row-level lock.** The transaction takes an explicit
`SELECT ... FOR UPDATE` on the `Message` row identified by
`waMessageId` before any other read in the same transaction.
The lock is held until the transaction commits or rolls back.
Concurrent reconciliations on the same `Message.id` therefore
serialize at the row-lock: the second transaction blocks at the
`SELECT FOR UPDATE` until the first commits, then re-reads the
post-commit state through the rest of the typed findFirst.

**Why `SELECT FOR UPDATE`, not `SERIALIZABLE` isolation.**
`SERIALIZABLE` would produce the same end-state for the canonical
DB row but cannot be applied to the typed `tx.message.findFirst`
Prisma 7 query (the adapter does not surface the conflict
consistently for read-modify-write on a single PK under the
PrismaPg adapter — verified empirically, see the lock probe
artefacts in the WA-ERA4-06 commit history). The row lock is
the smallest bounded change that closes the race without
introducing retry loops, schema changes, or a new
distributed-consistency model.

**No read-skew on a single row.** Under the row lock, two
transactions that both read and write the same `Message.id` are
serialized; no third value can be observed. This is verified by
`test/integration/status-reconciliation-concurrency.test.ts`
case C (concurrent duplicate READ events on a DELIVERED row),
which proves that exactly one of the two reconcile calls reports
`changed=true` and exactly one `message:status` is published.

**Cross-row concurrency is unaffected.** The row lock is
scoped to the `Message.id` of the reconciliation; two
reconciliations on different messages run in parallel. This is
verified by case E (concurrent updates from different tenants),
where each tenant's reconciliation commits to its own row
independently and each tenant's fake WebSocket client receives
exactly one `message:status` for its own message, never the
other's.

**No phantom reads across tables.** The reconciliation only
reads from `Message`, `OutboundSendAttempt`, `WebhookEvent`,
`Conversation`, and `PhoneNumber`. The `WebhookEvent` lookup
uses `findUnique` by PK; the `Conversation`/`PhoneNumber`
joins are immutable for the duration of the transaction under
the canonical tenant-WABA-phone binding. There is no read pattern
that could observe a phantom row.

### 15.2 Transaction Isolation Assumptions

- The database default isolation level is `READ COMMITTED`
  (verified: `SHOW default_transaction_isolation` returns
  `read committed`).
- The row lock is the only mechanism that closes the
  read-modify-write race; `nextStatus()` does not see uncommitted
  data from other transactions.
- The transaction uses a single `prisma.$transaction(async (tx)
  => ...)` block; the lock is acquired at the start, the
  `tx.message.update` and `tx.outboundSendAttempt.updateMany`
  finish inside the same block, and the publish guard runs
  after `prisma.$transaction` resolves. There is no window in
  which the lock is released before the DB write completes.

### 15.3 Proven Behavior of Concurrent Receipts

`test/integration/status-reconciliation-concurrency.test.ts` uses
two independent Prisma clients (each with its own connection
pool) so the two reconciliations run in parallel PostgreSQL
sessions on the same DB. The Hub is exercised through a fake
WebSocket attached to `globalThis.__waRealtime.connections`,
which receives the exact same `JSON.stringify` payload that
real browser clients see. The cases prove:

| Case | Initial | Concurrent webhooks | Final DB | Publishes | Invariant |
|------|---------|---------------------|----------|-----------|-----------|
| A | SENT | DELIVERED + READ | READ | DELIVERED, READ (monotonic) | Both transitions commit in order; no regression below SENT |
| B | DELIVERED | DELIVERED (no-op) + READ | READ | READ | Exactly one `changed=true`; no-op absorbs the duplicate |
| C | DELIVERED | READ + READ | READ | exactly one `message:status` | No duplicate logical mutation for the same transition |
| D | DELIVERED | FAILED + READ | READ or DELIVERED | per order | FAILED never wins over a higher rank |
| E | PENDING (tenant A) + PENDING (tenant B) | DELIVERED (A) + READ (B) | A: DELIVERED, B: READ | one per tenant | Strict tenant isolation; no cross-tenant payload leak |

`test/integration/status-publication-semantics.test.ts`
exercises the post-commit publication guarantees on a single
transaction:

1. `changed=false` produces zero `message:status` frames.
2. The DB row is at the post-commit value when
   `reconcileStatusEvent()` resolves; publish() runs after the
   transaction closes.
3. A transaction that throws (missing `WebhookEvent` id)
   rolls back: the DB row is unchanged, no frame is delivered.
4. An empty Hub connection set does not roll back the
   committed DB row. `publish()` is best-effort; failures are
   isolated per connection by
   `src/lib/realtime/local-delivery.ts`.

### 15.4 Post-Commit Publication Limitations

- **No exactly-once delivery guarantee.** A network partition,
  a Redis Pub/Sub redelivery, or a worker crash after commit
  but before publish can cause the same canonical transition to
  be published zero, one, or two times across the cluster.
  Clients must reconcile against the canonical PostgreSQL state
  (or against a later webhook). The Inbox client uses
  `OrderingGuard` and `SeenSet` (`src/lib/realtime/sync.ts`) to
  absorb duplicates and out-of-order events.
- **No automatic replay.** A dropped publish is not retried by
  the worker; the durable evidence is the DB row, and a later
  webhook (or a refetch triggered by the client) will catch up
  any client that missed a frame.
- **No cross-tenant replay.** Each `message:status` is routed
  to the tenantId of the reconciliation; a Hub crash that
  redelivers an event to the wrong tenant is prevented by the
  `deliverTenantEventToLocal` tenant filter.
- **Best-effort transport.** `publish()` never throws. A
  broken client connection does not block other clients; the
  per-send try/catch in `local-delivery.ts` is the isolation
  boundary. A broken Redis Pub/Sub adapter does not undo the DB
  commit either: the `publish()` call returns successfully even
  if the fan-out silently drops the envelope.

### 15.5 Failure / Recovery Limitations

- The status worker uses BullMQ's at-least-once delivery. A
  worker crash mid-transaction produces a BullMQ retry; the
  retry sees the rolled-back DB row and runs the reconciliation
  again from scratch.
- A row lock held by a crashed transaction is released by
  PostgreSQL when the connection is closed; the next
  reconciliation can proceed without manual intervention.
- The `prismaClient` injection point on
  `reconcileStatusEvent()` is test-only; production code uses
  the singleton. This is documented in the source.
- The lock is on `Message.id` (PK). If the same `waMessageId`
  is later found to map to multiple `Message.id`s in the
  schema (it cannot today, but the WA-ERA4-07 unread
  reconciliation may revisit this), the lock would need to be
  revisited; the `reconciliation.ts` location and the
  concurrency test are the canonical places to update.

### 15.6 Status Transition Inventory (rework)

`nextStatus(current, incoming)` is unchanged. The row lock
guarantees the function sees a consistent `current`; the
function itself remains the single authority on what ranks
are accepted.

| current | incoming | result | notes |
|---------|----------|--------|-------|
| PENDING | SENT | SENT | normal advance |
| SENT | DELIVERED | DELIVERED | normal advance |
| DELIVERED | READ | READ | normal advance |
| SENT | FAILED | FAILED | rank 1 == rank 1, accepted |
| DELIVERED | FAILED | DELIVERED | rank 1 < rank 2, kept |
| READ | FAILED | READ | rank 1 < rank 3, kept |
| READ | SENT | READ | rank 1 < rank 3, kept |
| DELIVERED | SENT | DELIVERED | rank 1 < rank 2, kept |
| any | same as current | current | `changed=false`, no publish |

The webhook-side `STATUS_MAP` (provider string → canonical enum)
and the publication wire payload
(`{type: "message:status", payload: {conversationId, waMessageId, status}}`)
are unchanged. No new event types, no new payload fields, no
schema changes. ERAs 1/2/3 are not touched.

### 15.7 Tests Added (rework)

- `test/integration/status-reconciliation-concurrency.test.ts`
  — 18 checks against real PostgreSQL using two independent
  Prisma clients and a Hub-attached fake WebSocket.
- `test/integration/status-publication-semantics.test.ts` —
  10 checks against real PostgreSQL for post-commit
  publication, rollback, and best-effort transport.
- Pre-existing `test/integration/status-worker.test.ts`
  continues to pass; the row lock and the existing outbox
  pipeline are compatible.

---

## 16. WA-ERA4-08 — Multi-Operator Coordination

**Task ID:** WA-ERA4-08
**Status:** PASS
**Date:** 2026-10-12
**Baseline:** 98eef25
**Scope:** Read-only inspection + targeted regression tests. No
implementation changes to production code.

### 16.1 Coordination model (AS-IS)

The Inbox is a multi-operator shared workspace. Each operator connects
to the WebSocket Hub with a session cookie and a tenantId; the Hub
binds every WebSocket connection to a single `(userId, tenantId)`
pair. The same tenant can have many operators connected concurrently.

Operator-to-operator coordination today happens through two paths:

1. **Shared conversation list query** — every operator's React Query
   cache holds `["conversations", tenantId]`. The PATCH handler at
   `src/app/api/tenants/[tenantId]/conversations/[conversationId]/route.ts`
   mutates the row and returns the updated record; the originating
   operator's `useMutation.onSuccess` invalidates the local list
   cache. A *non-originating* operator reconciles only on the next
   `useQuery` refetch (background poll / revalidation) — there is no
   server-pushed event for assignment or status changes.
2. **Realtime event stream** — `message:new`, `message:status`,
   `message:image-enriched`, `flow:submission`, `template:status`.
   These cover messages and template workflow; they do not cover
   `assignedUserId` or `ConversationStatus` mutations.

**The catalog is intentionally closed** (WA-ERA4-04): producers may
emit new event types, but the canonical validators only strengthen
the *known* set. Adding `conversation:assigned` or `conversation:status`
would be a new public event type, which the ERA 4 packet forbids.

### 16.2 Assignment semantics

| Aspect | Behavior |
|--------|----------|
| Mutating endpoint | `PATCH /api/tenants/:tenantId/conversations/:id` (body: `{ assignedUserId?, status?, unreadCount? }`) |
| Repository call | `tenantMessagingRepository.updateConversation(ctx, id, { assignedUserId })` |
| SQL statement | `UPDATE Conversation SET assignedUserId = $1 WHERE id = $2 AND tenantId = $3 AND contact.tenantId = $3` |
| Authorization | `resolveTenantContext()` requires a `TenantMembership` row for `(userId, tenantId)`. ADMIN role does NOT bypass membership. |
| Cross-tenant attempt | `updateMany` reports `count=0`; repository returns `null`; handler returns 404. The row is untouched. |
| Idempotency | A repeated identical PATCH reports `count=1` both times; the row reflects the requested value. The handler has no idempotency key, so client retries that land between two operator actions will apply the latest submitted value. |
| Conflict policy | **Last-write-wins.** No row-level lock, no application-level compare-and-swap, no version column. Two operators racing to assign the same conversation: whichever commit lands last wins. The losing operator's `useMutation` has no rollback (the PATCH succeeded server-side; the local list is invalidated and the next refetch shows the canonical state). |
| Optimization policy | None. The `updateMany` is a single SQL statement; the database decides the final state. No outbox, no event published. |
| Coordinator handoff | None. The PATCH handler does not call `publish()`. Operators on the same tenant see the change on the next `useQuery` refetch (TanStack background poll or 60s Hub revalidate). |
| Self-assignment | Allowed. A user can assign a conversation to themselves. There is no policy restricting this in the PATCH body; the `assignedUserId` is whatever the client submitted, as long as Zod validates it. |

### 16.3 Conversation status transitions

| Aspect | Behavior |
|--------|----------|
| Mutating endpoint | Same PATCH endpoint, body: `{ status: "OPEN" \| "CLOSED" }` |
| Repository call | `tenantMessagingRepository.updateConversation(ctx, id, { status })` |
| Allowed values | `OPEN`, `CLOSED` (Prisma enum `ConversationStatus`) |
| Transition policy | The repository does not check the previous status. Any valid value can replace any other. |
| Conflict policy | Same as assignment: last-write-wins. |
| Concurrent identity | Two operators racing to set the same status end up with whichever committed last; an operator racing close vs. leave-open ends with one of the two. The row remains valid (`status ∈ {OPEN, CLOSED}`). |
| Effect on `unreadCount` | Not affected by status changes. Unread is governed by WA-ERA4-07. |
| Effect on `assignedUserId` | Not affected by status changes. Independent field. |

### 16.4 Authorization boundaries

| Boundary | Enforcement point | Test |
|----------|-------------------|------|
| Authenticated session | `auth()` in PATCH handler; no session → 401. | `returns 401 when no session exists` |
| Tenant membership | `resolveTenantContext()` checks `TenantMembership`; missing → 403. | `returns 403 when authenticated user has no tenant membership` |
| ADMIN bypass | The application does not check `session.user.role` for tenant access. ADMIN without membership still gets 403. | `returns 403 when ADMIN has no tenant membership (ADMIN cannot bypass)` |
| Cross-tenant conversation | Repository's `updateMany` filters on `tenantId + contact.tenantId`. Count=0 means no row matched; the row is untouched. | `returns 404 when the repository reports the conversation is not visible to this tenant`, integration G |
| Body field allowlist | Zod schema `updateSchema` rejects `id`, `tenantId`, `contactId` (and any other non-allowlisted field). The repository is never called with attacker-controlled identity fields. | `ignores identity fields (id, tenantId, contactId) submitted in the body` |
| Body field semantics | The Zod schema restricts `status` to `"OPEN" \| "CLOSED"` and `unreadCount` to a number. No boolean / string coercion. | Tested by `tenant-conversation-http.test.ts` PATCH suite. |

### 16.5 Post-commit publication discipline

The PATCH handler commits the database write and returns the updated
record. It does NOT call `publish()`. This is consistent with the
"realtime notifications are ephemeral and best-effort" invariant
(ADR-0002 / AGENTS.md §4). Operators reconcile via refetch, not via
push. If a future change attempts to publish from the PATCH handler,
`test/multi-agent-coordination.test.ts` fails closed.

### 16.6 Multi-operator client synchronization

Two independent operator clients (separate `QueryClient` instances,
separate WebSocket connections) on the same tenant observe the
following:

- A `message:new` notification triggers a list invalidation on both.
  See `test/realtime-client-sync-integration.test.ts` for the harness.
- An assignment or status change (PATCH) does NOT trigger a list
  invalidation on the non-originating operator. The non-originating
  operator sees the change on the next refetch.
- The originating operator's `useMutation.onSuccess` invalidates the
  local list, so the originator sees the change immediately.

There is no two-consumer integration test that specifically covers a
PATCH-driven assignment or status change, because no event is published
to drive a deterministic re-render. The
`test/realtime-client-sync-integration.test.ts` suite already covers
the `message:*` and `flow:*` events; the only thing missing is a
`conversation:*` event, which the ERA 4 packet forbids.

### 16.7 Optimistic UI

The Inbox client does NOT use optimistic updates for assignment or
status changes. The mutations it does perform (`sendText`, `sendMedia`,
`sendTemplate`, `sendFlow`) each invalidate the list/thread cache in
`onSuccess` and surface a destructive toast in `onError`. A failed
mutation does not appear confirmed because the cache is only
invalidated on success.

### 16.8 Failure semantics

| Failure | Effect |
|---------|--------|
| Database failure during PATCH | The `updateMany` throws. The handler does not catch generic errors; the framework returns 500. No `publish()` is called. No partial state. |
| Transaction rollback | If the caller's transaction rolls back, the `updateMany` inside it is rolled back. PostgreSQL guarantees atomicity; integration test E demonstrates this with a simulated `throw` inside `$transaction`. |
| Redis outage | The PATCH handler does not call `publish()` or `publishGlobal()`. A Redis outage cannot affect the canonical state. The next list refetch (HTTP) is independent of Redis. |
| Duplicate notifications | Not applicable: PATCH does not publish. |
| Client HTTP failure | The originating operator's `useMutation.onError` shows a destructive toast. The cache is NOT invalidated; the operator sees the previous state until they retry. |
| Canonical refetch restores correct state | Yes. The repository returns the current row on every successful PATCH; the response is the new canonical state. The originating operator's cache is invalidated and refetched. Non-originating operators see the new state on their next background poll. |

### 16.9 Remaining limitations (intentional)

- No realtime event for assignment or status changes. Operators on
  the same tenant reconcile via HTTP refetch. To change this, a new
  public event type would be required (e.g.
  `conversation:assigned` / `conversation:status`), which the ERA 4
  packet explicitly forbids.
- No row-level lock on assignment/status. Two operators racing to
  assign the same conversation produce last-write-wins. To change
  this, either a `version` column on `Conversation` (Prisma schema
  change, forbidden by packet) or a `SELECT … FOR UPDATE` row lock
  would be needed. The integration test A demonstrates that this
  policy is consistent and predictable.
- No client UI to invoke the PATCH for assignment or status today.
  The handler exists and is exercised by the test suite. UI is
  out of scope for WA-ERA4-08.
- No `realtime` event is published for `message:status` updates to
  the conversation list (already covered by WA-ERA4-07). Assignment
  and status mutations on the conversation row are out of scope for
  the realtime event contract by design.

### 16.10 Tests added

- `test/multi-agent-coordination.test.ts` — 13 checks covering:
  - PATCH HTTP layer: 401, 403 (no membership), 403 (ADMIN without
    membership), 400 (empty body), 404 (cross-tenant), identity-field
    rejection, no-publish-after-success.
  - Repository layer: WHERE clause shape, DATA column allowlist,
    cross-tenant count=0, empty-data no-op.
  - Concurrent semantics: two parallel `updateMany` calls each succeed,
    repository does not call `publish()`.
- `test/integration/multi-agent-coordination.test.ts` — 7 checks
  against real PostgreSQL using two independent Prisma clients:
  - A. Concurrent assignment: both succeed, final assignee is one of
    the two, `tenantId` unchanged.
  - B. Concurrent status: both succeed, final status is valid.
  - C. Cross-tenant update: `count=0`, row untouched.
  - D. Repeated identical PATCH: both succeed, row reflects value.
  - E. Transaction rollback: status restored to OPEN after throw.
  - F. No publish() side effect (structural witness).
  - G. Tenant isolation under concurrent cross-tenant attempt.

No production code changed. ERAs 1/2/3 are not modified. The
`tenantMessagingRepository` and PATCH handler are unchanged.

---

## 17. WA-ERA4-08 — `conversation:updated` Event Contract

**Task ID:** WA-ERA4-08-CONVERSATION-EVENT
**Status:** Implemented (this commit)
**Date:** 2026-10-12
**Baseline:** 17323bf
**Scope:** Add one new tenant-scoped event (`conversation:updated`),
publish it from the conversation PATCH endpoint after a successful
canonical write, and consume it in the Inbox client to refetch the
canonical conversation list.

### 17.1 Approved contract

```
type: "conversation:updated"
payload: { conversationId: string }
scope: tenant
```

The event is an **invalidation signal**, not a copy of the canonical
state. The payload carries ONLY the conversationId so the client can
issue a canonical refetch from the existing HTTP API. The payload
intentionally does NOT include `assignedUserId` or `status`: the
producer MUST NOT project mutable state into the event because the
event is best-effort and not the source of truth.

### 17.2 Producer and consumer responsibilities

**Producer (POST-COMMIT, BEST-EFFORT)**

The PATCH endpoint at
`src/app/api/tenants/[tenantId]/conversations/[conversationId]/route.ts`
publishes the event after a successful canonical PostgreSQL write:

- Only when the request passes authorization (401/403/404 short-circuits
  before publish is called).
- Only when the body schema parses (400 short-circuits before publish).
- Only when the repository's `updateMany` reports `count=1` (the
  cross-tenant / not-found path returns 404 without publish).
- Only when at least one of the mutated fields (`status`,
  `assignedUserId`, `unreadCount`) actually differs from the pre-state
  (no-op PATCH produces no event).

The publish call uses the existing `publish(event, tenantId)` helper
from `src/server/realtime.ts`. The helper is fire-and-forget: it
never throws, never reverts the canonical commit, and never blocks the
HTTP response.

**Consumer (REFETCH CANONICAL STATE)**

The Inbox client (`src/app/(app)/inbox/inbox-client.tsx`) wires
`conversation:updated` through the existing `processEvent` helper in
`src/lib/realtime/sync.ts`. The decision matrix is:

- Active thread matches `payload.conversationId` → refetch list AND
  refetch thread (canonical state may have changed).
- Active thread is null or different → refetch list only.

The client NEVER mutates `assignedUserId`, `status`, or
`unreadCount` directly from the WebSocket payload. The WebSocket
notification only invalidates; the canonical refetch is the source of
truth.

### 17.3 Post-commit semantics

| Step | Owner | State change |
|------|-------|--------------|
| 1. PATCH HTTP request | Browser | None |
| 2. Auth + tenant check | Route handler | None |
| 3. Zod body parse | Route handler | None |
| 4. `prisma.conversation.updateMany` | PostgreSQL | **COMMITTED** |
| 5. `findConversation` to read post-state | PostgreSQL | None |
| 6. `publish({ type: "conversation:updated", payload }, tenantId)` | Hub + Redis | Best-effort, async |
| 7. Return 200 to the originating operator | Route handler | None |

Steps 1–5 are synchronous from the route handler's perspective.
Step 6 happens AFTER the canonical commit. If `publish` throws (it
doesn't, but if it did), the response is unaffected. If Redis is
unavailable, `publish` logs and continues; the local instance still
delivers to its own WebSocket clients through the local fan-out path
in `src/lib/realtime/local-delivery.ts`.

### 17.4 Last-write-wins preservation

The PATCH handler still relies on the existing repository's
`updateMany(...).count === 1` semantic. The repository applies the
last write that lands in the database. The new event does NOT
introduce a new conflict policy: it is a notification, not a
synchronization primitive. Two operators racing to assign the same
conversation both see HTTP 200; the final canonical row is whichever
write committed last; both operators receive the post-commit
notification, both refetch, both converge on the same canonical
state.

### 17.5 Canonical HTTP reconciliation

The client NEVER trusts the WebSocket payload. On
`conversation:updated` it issues:

- `qc.invalidateQueries({ queryKey: ["conversations", tenantId] })` —
  always.
- `qc.invalidateQueries({ queryKey: ["thread", tenantId, conversationId] })` —
  only when the active thread matches.

The next render of the Inbox triggers the existing `useQuery` refetch
path, which goes through the canonical GET endpoints. The WebSocket
event never short-circuits this — it can only ADVANCE the invalidation.

### 17.6 Backward compatibility

- The public `RealtimeEvent` shape (`{ type: string; payload: unknown }`)
  is unchanged.
- The catalog of TENANT_EVENT_TYPES is additive: existing clients
  that don't know about `conversation:updated` pass it through
  `processEvent` with `["message:new", "message:status",
  "message:image-enriched"]` as the known-types list. The seen-set
  has no entry for the event (it carries no embedded message), so
  the verdict is `{ admitted: false, reason: "malformed" }` and the
  Inbox silently ignores it without altering state.
- The `validateEnvelopeScope` function accepts unknown event types
  (the wire is open). The `validatePayloadShape` function
  tightens validation for `conversation:updated` only when the event
  type is recognized.
- The PATCH handler preserves its current HTTP response shape: the
  same JSON body, the same status codes, the same `toConversationRead`
  projection.

### 17.7 Best-effort notification limitations

- **At-most-once**: Redis Pub/Sub does not retain messages. A
  disconnected WebSocket client MISSES the notification. On reconnect
  it does not replay missed events; it refetches from the canonical
  HTTP API.
- **No ordering guarantee**: PostgreSQL commits are ordered (last
  write wins), but Redis Pub/Sub may deliver notifications to a peer
  instance in a different order. The `OrderingGuard` in
  `src/lib/realtime/sync.ts` does not apply to `conversation:updated`
  (it carries no message timestamp). The client refetches and accepts
  whatever canonical state the database reports.
- **No durable log**: a server crash between the commit and the
  publish does not retry. The next refetch (background poll or
  manual reload) reconciles.
- **No cross-tenant leak**: the Hub's `publish()` validates the
  scope at the producer boundary; the Redis channel name encodes the
  tenantId; the `deliverTenantEventToLocal` helper in
  `src/lib/realtime/local-delivery.ts` filters by `info.tenantId ===
  tenantId` on every iteration.

### 17.8 Files changed

Production:
- `src/lib/realtime/events.ts` — added `conversation:updated` to
  `TENANT_EVENT_TYPES` and `EVENT_PRODUCER_MAP`; added
  `ConversationUpdatedPayload` type.
- `src/lib/realtime/contracts.ts` — added
  `case "conversation:updated"` in `validatePayloadShape` enforcing
  `conversationId: string`.
- `src/lib/realtime/sync.ts` — added `conversation:updated` case in
  `classifyEvent` (list always, list+thread when active matches).
- `src/app/api/tenants/[tenantId]/conversations/[conversationId]/route.ts`
  — import `publish`; emit after a successful canonical write, only
  when the body actually mutated the row.
- `src/app/(app)/inbox/inbox-client.tsx` — added
  `"conversation:updated"` to the `processEvent` known-types list.

Tests:
- `test/realtime-contracts.test.ts` — added payload-shape and
  scope-validation tests for `conversation:updated`.
- `test/realtime-client-sync.test.ts` — added `classifyEvent` and
  `processEvent` tests for the new event.
- `test/realtime-client-sync-integration.test.ts` — added a
  `WA-ERA4-08` describe block with five multi-operator scenarios
  (convergence, list+thread on match, list-only on mismatch,
  duplicate safety, tenant isolation).
- `test/multi-agent-coordination.test.ts` — replaced the prior
  "does not publish" assertion with four new assertions covering
  publish-on-success, no-publish-on-noop, no-publish-on-404, and
  no-publish-on-cross-tenant.

### 17.9 Acceptance gate evidence

| Gate | Evidence |
|------|----------|
| `conversation:updated` catalogued | `events.ts` `TENANT_EVENT_TYPES` |
| Tenant scope validation | `contracts.ts` `validateEnvelopeScope` |
| Payload validation | `test/realtime-contracts.test.ts` "accepts a well-formed conversation:updated payload" |
| Existing contracts preserved | `test/realtime-contracts.test.ts` 5 pre-existing payload tests |
| PATCH publication after commit | `test/multi-agent-coordination.test.ts` "publishes conversation:updated after a successful assignment/status PATCH" |
| No publication on failed mutation | `test/multi-agent-coordination.test.ts` "does not publish conversation:updated on a 404 PATCH" |
| No publication on unauthorized | `test/multi-agent-coordination.test.ts` "does not publish conversation:updated for cross-tenant PATCH" |
| No publication on unchanged state | `test/multi-agent-coordination.test.ts` "does not publish conversation:updated when the PATCH body matches the existing state" |
| HTTP compatibility preserved | `test/multi-agent-coordination.test.ts` "ignores identity fields" |
| Last-write-wins preserved | `test/integration/multi-agent-coordination.test.ts` A, B, C, D, E |
| Two-operator assignment sync | `test/realtime-client-sync-integration.test.ts` "two operators converge on the new assignee" |
| Two-operator status sync | Same test; the Inbox client refetches the same canonical list regardless of which field changed |
| Cross-tenant isolation | `test/realtime-client-sync-integration.test.ts` "tenant switching isolates the conversation:updated event" |
| Duplicate handling | `test/realtime-client-sync-integration.test.ts` "duplicate conversation:updated notifications are harmless" |
| Stale-response protection | Pre-existing `RequestToken` test in `test/realtime-client-sync.test.ts` "RequestToken rejects stale responses" |
| ERAs 1/2/3 preserved | No schema, no migrations, no Prisma client changes; no `message:status` semantics change |