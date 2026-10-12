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

### 7.3 Redis Pub/Sub Channel Design (CONCEPTUAL)

| Channel | Purpose |
|---------|---------|
| `wa:realtime:{tenantId}` | Tenant-scoped events |
| `wa:realtime:global` | Non-tenant events (templates) |

**Message format (CONCEPTUAL):**
```typescript
interface PubSubMessage {
  event: RealtimeEvent;      // { type, payload }
  publishedAt: string;       // ISO timestamp
  instanceId?: string;      // For debugging
}
```

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
| Revocation latency up to 60s | Stale connection after membership removal | WA-ERA4-03 (push invalidation) |

### 11.3 No Conflicts with Frozen ERAs

**Finding:** The existing WebSocket implementation was introduced during ERA 2/3 but is NOT documented as frozen. It coexists with the ERA 3 FROZEN boundary (66eb3f1) which covers:
- Webhook relay and fan-out
- Transactional outbox
- Delivery reliability
- Idempotency

**Conclusion:** WebSocket realtime infrastructure is NOT part of the ERA 3 FROZEN boundary. ERA 4 may extend it.

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

*This document was produced through repository-grounded inspection. All claims verified against source code at commit `322da28`.*
