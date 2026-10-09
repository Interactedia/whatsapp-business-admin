# Architecture Baseline Report

- Task: WA-BASELINE-001
- Date: 2026-10-09
- Executor: layer-2-workers
- Status: Baseline verified and documented

---

## A. Repository Identity

| Property | Value |
|----------|-------|
| Project | whatsapp-business-admin |
| Version | v0.1.1 |
| Forked from | github.com/Interactedia/whatsapp-business-admin.git |
| Initial commit | 28ab60ba9cabae3fdaba15527e6f22c46355a4db |
| Clone date | 2026-10-09 |
| License | Not specified in repository |

---

## B. Git Baseline

| Property | Value |
|----------|-------|
| Branch | main |
| Initial HEAD | 28ab60b refactor: extract template picker, add draft util |
| Initial worktree | M README.md (pre-existing unrelated change) |

---

## C. Verified Technology Stack

| Component | Version | Source |
|-----------|---------|--------|
| Next.js | ^16.3.4 | package.json |
| React | ^19.2.8 | package.json |
| TypeScript | ^6.0.3 | package.json |
| Prisma | ^7.10.0 | package.json |
| Node.js | >=24 <25 | package.json engines |
| PostgreSQL | 16 | docker-compose.yml, prisma schema |
| next-auth | ^5.0.0-beta.32 | package.json |
| ws (WebSocket) | ^8.21.3 | package.json |
| p-queue | ^9.3.3 | package.json |
| Zod | ^4.5.4 | package.json |
| Tailwind CSS | ^4.3.3 | package.json |

---

## D. Existing Architecture (AS-IS)

### Database Schema

**Datasource**: PostgreSQL (provider = "postgresql")

**Singleton Model**:
- `WabaSettings` (id = "default") — holds WABA credentials, access token encrypted (AES-256-GCM)

**User & Auth Models**:
- `User` — email, passwordHash, role (ADMIN/AGENT), active
- `ApiKey` — SHA-256 hash stored, keyPrefix for identification

**Message Models**:
- `Contact` — waId (E.164), name, profileName, tags[], notes
- `Conversation` — contactId (unique), status (OPEN/CLOSED), assignedUserId, unreadCount
- `Message` — type (TEXT/IMAGE/VIDEO/AUDIO/DOCUMENT/LOCATION/CONTACTS/STICKER), status (PENDING/SENT/DELIVERED/READ/FAILED), sentByUserId

**Template Models**:
- `Template` — name, language, category, status, components (Json), metaTemplateId

**Broadcast Models**:
- `Broadcast` — templateId, status (DRAFT/SCHEDULED/RUNNING/COMPLETED/FAILED), recipients[], sentCount, failedCount
- `BroadcastRecipient` — contactId, waMessageId, status, error

**Flow Models**:
- `Flow`, `FlowLaunch`, `FlowStep` — Meta WhatsApp Flows integration

**Queue/Job Models**:
- `OutboundJob` — type, payload, status (PENDING/SCHEDULED/COMPLETED/FAILED), retryCount, error
- `WebhookEvent` — raw payload stored, signatureValid, processedOk

### Broadcast Implementation

**Location**: `src/lib/whatsapp/broadcast.ts`

**Queue**: `p-queue` with concurrency=8, interval=1000, intervalCap=20

**Behavior**:
- `runBroadcast(broadcastId)` kicks off sending, returns immediately
- In-process queue processes template messages
- `maybeComplete()` marks broadcast COMPLETED when all recipients processed
- Process restart survival: NOT PROVEN — p-queue is in-process, not durable

### WebSocket Implementation

**Location**: `src/server/realtime.ts`, `server.ts`

**Package**: `ws` (WebSocketServer)

**Rooms**:
- `"global"` — all connected clients
- `"conversation:{id}"` — per-conversation subscriptions

**Transport**: Events only, not truth. Clients must recover state from authenticated APIs.

**Multi-process propagation**: NOT PROVEN — single-process WebSocketServer only

### Authentication

**Provider**: next-auth v5 (beta)

**Config**: `src/auth.ts`, `src/auth.config.ts`

**Proxy**: `src/proxy.ts` — protects routes, excludes `/api/auth`, `/api/webhook`, `/api/v1`, `/api/whatsapp/flows/data`

**API Keys**: SHA-256 hash stored in `ApiKey` model for `/api/v1` authentication

### Webhook Processing

**Location**: `src/lib/whatsapp/webhook.ts`

**Inbound**: Raw payload stored in `WebhookEvent` table before processing

**Signature validation**: Implemented (signatureValid field)

**Transaction atomicity**: NOT FULLY PROVEN — webhook receipt + status update may not be atomic

### Deployment Artifacts

**Docker files present** (legacy upstream):
- `docker-compose.yml` — PostgreSQL 16 Alpine, optional app container
- `Dockerfile` — exists in root

**Status**: Legacy artifacts only. NOT approved deployment path per ADR-0003.

---

## E. Approved Architecture Direction (TO-BE)

| Component | Status | Notes |
|-----------|--------|-------|
| Native Linux deployment | Accepted | Node.js, PostgreSQL as native services |
| Tenant-aware domain | Accepted (principle) | Schema pending separate approval |
| Durable queues (Redis/BullMQ) | Proposed | Not yet approved |
| Webhook relay | Proposed | Not yet approved |
| Change control | Accepted | AGENTS.md + ADRs governance |

---

## F. Proposed Components Not Yet Authorized

| Component | ADR | Status | Blocker |
|-----------|-----|--------|---------|
| Redis/BullMQ durable queue | ADR-0005 | Proposed | Needs implementation packet + approval |
| Canonical event envelope | ADR-0006 | Proposed | Needs implementation packet + approval |
| Transactional outbox | ADR-0005 | Proposed | Part of BullMQ proposal |
| External webhook relay | ADR-0006 | Proposed | Part of event envelope proposal |

---

## G. Documentation Verification Matrix

| Document | Verification Status | Findings | Corrections |
|----------|-------------------|----------|--------------|
| AGENTS.md | VERIFIED with correction | Line 7: "Next.js 16" should be "^16.3.4" | Corrected |
| docs/adr/README.md | VERIFIED | Correctly describes ADR statuses | None |
| docs/adr/0001-existing-baseline.md | VERIFIED | Correctly marked as "Recorded (unverified)" | None |
| docs/adr/0002-product-boundaries.md | VERIFIED | Correctly describes scope boundaries | None |
| docs/adr/0003-native-deployment.md | VERIFIED | Correctly prohibits Docker, preserves legacy artifact | None |
| docs/adr/0004-tenant-aware-domain.md | VERIFIED | Correctly notes "schema pending" | None |
| docs/adr/0005-durable-queues.md | VERIFIED | Correctly marked as "Proposed" | None |
| docs/adr/0006-webhook-relay.md | VERIFIED | Correctly marked as "Proposed" | None |
| docs/adr/0007-change-control.md | VERIFIED | Correctly establishes governance | None |

---

## H. Code/Documentation Discrepancies

| Item | Documentation | Repository | Resolution |
|------|---------------|------------|------------|
| Next.js version | "Next.js 16" | "^16.3.4" | Corrected in AGENTS.md |

**Other observations** (NOT discrepancies):
- ADR-0001 correctly identifies WabaSettings as singleton
- ADR-0001 correctly identifies p-queue as in-process
- ADR-0001 correctly notes docker-compose.yml as legacy
- All ADR statuses correctly reflect their approval state

---

## I. Architectural Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| p-queue broadcasts not durable | Medium | ADR-0005 proposes BullMQ solution |
| Single-process WebSocket | Medium | Clients recover from API; multi-process needs separate design |
| No transactional outbox proven | Medium | ADR-0005 addresses this |
| Singleton WabaSettings limits multi-WABA | Low | ADR-0004 addresses multi-tenant direction |

---

## J. Decisions Requiring Human Approval

| Decision | Description | Blocker Type |
|----------|-------------|--------------|
| None at this time | All documentation discrepancies resolved | N/A |

**Open questions from ADRs** (NOT blocking):
- ADR-0004: Membership roles, tenant signup/switching, existing-record ownership backfill, tenant-scoped authorization, and whether DB RLS adds value in this stack
- ADR-0005: Redis vs PostgreSQL-backed queue comparison
- ADR-0006: Canonical event catalog, subscription lifecycle

**WA-01-01 persistence foundation:** added additive Prisma models `Tenant`, `WabaAccount`, and `PhoneNumber` with `Tenant` 1:N `WabaAccount` and `WabaAccount` 1:N `PhoneNumber`. Meta identifiers are stored as `metaWabaId` and `metaPhoneNumberId` with per-parent uniqueness constraints. The migration creates only these new tables, indexes, and foreign keys. Legacy `WabaSettings` remains the credential source and is not replaced or migrated. Multi-tenancy is not operational in WA-01-01.

---

## K. Recommended Next Development Task

**Recommended**: WA-01 — Tenant/WABA Foundation

**Scope** (to be defined in implementation packet):
- Add tenantId to relevant models
- Update WabaSettings to support multiple WABAs
- Implement tenant-scoped authorization
- Database migrations with rollback plan

**Prerequisites**: Separate implementation packet with:
- Baseline evidence from actual repository
- Explicit scope and exclusions
- Acceptance tests
- Migration/rollback strategy

**This task does NOT implement WA-01** — it only recommends it as the next unit.

---

## Verification Evidence

### Files Inspected

```
/home/yoab/Dev/whatsapp-business-admin/AGENTS.md
/home/yoab/Dev/whatsapp-business-admin/docs/adr/README.md
/home/yoab/Dev/whatsapp-business-admin/docs/adr/0001-existing-baseline.md
/home/yoab/Dev/whatsapp-business-admin/docs/adr/0002-product-boundaries.md
/home/yoab/Dev/whatsapp-business-admin/docs/adr/0003-native-deployment.md
/home/yoab/Dev/whatsapp-business-admin/docs/adr/0004-tenant-aware-domain.md
/home/yoab/Dev/whatsapp-business-admin/docs/adr/0005-durable-queues.md
/home/yoab/Dev/whatsapp-business-admin/docs/adr/0006-webhook-relay.md
/home/yoab/Dev/whatsapp-business-admin/docs/adr/0007-change-control.md
/home/yoab/Dev/whatsapp-business-admin/package.json
/home/yoab/Dev/whatsapp-business-admin/prisma/schema.prisma
/home/yoab/Dev/whatsapp-business-admin/src/lib/whatsapp/broadcast.ts
/home/yoab/Dev/whatsapp-business-admin/src/server/realtime.ts
/home/yoab/Dev/whatsapp-business-admin/server.ts
/home/yoab/Dev/whatsapp-business-admin/docker-compose.yml
```

### Git Evidence

```
Branch: main
Initial HEAD: 28ab60b refactor: extract template picker, add draft util
Initial worktree: M README.md (pre-existing unrelated change)
```

---

**Report generated**: 2026-10-09
**Verification method**: Direct repository inspection
**Documentation corrections**: 1 (Next.js version in AGENTS.md)
