# WA-ERA2-13 — End-to-End Integration and Failure Certification Evidence

**Task ID:** WA-ERA2-13-INTEGRATION-FAILURE-TESTING  
**Status:** PASS  
**Date:** 2026-10-11  
**Baseline Commit:** f5a13f6  

---

## 1. Executive Summary

This document certifies that the asynchronous messaging pipelines of WhatsApp Business Admin (`inbound.webhook`, `outbound.message`, `status.reconciliation`, `broadcast.dispatch`) preserve:
1. **Data integrity:** PostgreSQL remains the durable system of record; outbox intent survives process and transport failures.
2. **Tenant isolation:** Strict boundary enforcement across tenants, WABAs, and phone numbers before any business mutation.
3. **Idempotency:** Duplicate events and concurrent execution do not duplicate business side effects or external Meta dispatches.
4. **Recovery & lease safety:** Stalled jobs, expired claims, and dispatcher/worker restarts recover safely.
5. **External send safety:** The `metaRequestStartedAt` boundary guarantees that ambiguous external outcomes remain `UNCERTAIN` and are never automatically retransmitted.
6. **Observability fail-isolation:** System metrics remain read-only, fail-isolated, and never convert infrastructure outages into false zero counts.

All 16 required failure and integration scenarios (A–P) are verified with passing deterministic evidence on real PostgreSQL and Redis infrastructure.

---

## 2. Infrastructure Environment

- **Host Platform:** Linux (x86_64)
- **Node.js:** v24.13.1 (within package requirement `>=24 <25`)
- **PostgreSQL:** PostgreSQL 16 (local port 5434 / standard 5432)
- **Redis:** Redis 7.0 (local port 6379)
- **Prisma Client:** 7.10.0
- **BullMQ:** 6.3.12
- **Meta Graph API:** v21.0 (Mocked boundary; no real Meta external network calls)

---

## 3. Failure & Recovery Scenario Matrix (A–P)

| Scenario | Description | Primary Test Files | Coverage | Result | Check Count |
|---|---|---|---|---|---|
| **A** | Redis outage and recovery | `redis-failure-handling.test.ts`<br>`redis-integration.test.ts`<br>`outbox-dispatch.test.ts`<br>`inbound-worker.test.ts`<br>`broadcast-outbox.test.ts` | COVERED | PASS | 7/7<br>11/11<br>5/5<br>8/8<br>12/12 |
| **B** | PostgreSQL outage and recovery | `outbox-postgres.test.ts`<br>`inbound-outbox.test.ts`<br>`status-outbox.test.ts`<br>`observability-failure-isolation.test.ts` | COVERED | PASS | 7/7<br>7/7<br>5/5<br>13/13 |
| **C** | Outbox publication replay | `outbox-dispatch.test.ts`<br>`stalled-job-recovery.test.ts` | COVERED | PASS | 5/5<br>17/17 |
| **D** | Lost publication acknowledgment | `outbox-dispatch.test.ts` (test 4) | COVERED | PASS | 5/5 |
| **E** | Dispatcher restart | `outbox-dispatch.test.ts`<br>`stalled-job-recovery.test.ts` (S1) | COVERED | PASS | 5/5<br>17/17 |
| **F** | Worker restart | `inbound-worker.test.ts` (test 7)<br>`stalled-job-recovery.test.ts` (S4, S6) | COVERED | PASS | 8/8<br>17/17 |
| **G** | Stalled job recovery | `stalled-job-recovery.test.ts` (S1–S7) | COVERED | PASS | 17/17 |
| **H** | Duplicate concurrent execution | `outbox-postgres.test.ts`<br>`outbound-attempt-postgres.test.ts`<br>`inbound-worker.test.ts`<br>`tenant-contact-identity.test.ts` | COVERED | PASS | 7/7<br>23/23<br>8/8<br>3/3 |
| **I** | Retry exhaustion and terminal state | `stalled-job-recovery.test.ts` (S2, S7)<br>`outbound-attempt-postgres.test.ts` (E1–E3)<br>`broadcast-worker.test.ts` (T4) | COVERED | PASS | 17/17<br>23/23<br>21/21 |
| **J** | Poison event isolation | `bullmq-integration.test.ts`<br>`stalled-job-recovery.test.ts` (S2)<br>`outbound-worker.test.ts` (T6)<br>`inbound-worker.test.ts` (T6) | COVERED | PASS | 17/17<br>17/17<br>17/17<br>8/8 |
| **K** | Inbound duplicate webhook | `inbound-worker.test.ts` (tests 4–5)<br>`inbound-outbox.test.ts` | COVERED | PASS | 8/8<br>7/7 |
| **L** | Outbound ambiguous Meta outcome | `outbound-worker.test.ts` (T3–T4)<br>`stalled-job-recovery.test.ts` (S5–S6)<br>`broadcast-worker.test.ts` (T3) | COVERED | PASS | 17/17<br>17/17<br>21/21 |
| **M** | Status duplicate / out-of-order events | `status-worker.test.ts` (tests 4–5) | COVERED | PASS | 6/6 |
| **N** | Broadcast cancellation during recovery | `broadcast-worker.test.ts` (T5)<br>`broadcast-outbox.test.ts` | COVERED | PASS | 21/21<br>12/12 |
| **O** | Cross-tenant forged references | `broadcast-worker.test.ts` (T6–T7)<br>`outbound-worker.test.ts` (T6)<br>`inbound-worker.test.ts` (T6)<br>`status-worker.test.ts` (T6)<br>`tenant-contact-identity.test.ts`<br>`tenant-identity-migration-rehearsal.test.ts` | COVERED | PASS | 21/21<br>17/17<br>8/8<br>6/6<br>3/3<br>13/13 |
| **P** | Monitoring under Redis/PostgreSQL failure | `test/lib/observability/queue-outbox-observability.test.ts`<br>`test/queue-observability.test.ts`<br>`test/integration/observability-failure-isolation.test.ts` | COVERED | PASS | 2/2<br>4/4<br>13/13 |

---

## 4. Reused Evidence & Certified Guarantees

1. **Transactional Outbox Durability (ERA2-04 & ERA2-05):**
   - OutboxEvent rows are committed in the same database transaction as the business trigger.
   - Dispatcher uses `SELECT ... FOR UPDATE SKIP LOCKED` ensuring exactly one dispatcher acquires an outbox event batch.
   - Redis unavailability during dispatch transitions event to `RETRYABLE` with redacted error, never losing committed intent.
   - Lost acknowledgment recovery: expired leases in `CLAIMED` are reclaimed and re-published via BullMQ with `replaceExisting: true`, preventing job duplication.

2. **Inbound Processing (ERA2-06):**
   - Inbound webhook raw payload and receipt are persisted before worker processing.
   - Canonical `Message.waMessageId` constraint and idempotency checks prevent duplicate message insertion under webhook re-delivery or worker replay.

3. **Outbound Boundary & Meta Ambiguity Protection (ERA2-07 & ERA2-10):**
   - Worker atomically claims the `OutboundSendAttempt` row with a lease (`claimExpiresAt`).
   - `metaRequestStartedAt` is durably written to PostgreSQL *before* making the HTTP request to Meta.
   - If Meta returns a 5xx, 429, timeout, network failure, or corrupt response, the attempt transitions to `UNCERTAIN`.
   - Recovery functions (`releaseExpiredOutboundClaim`, `releaseExpiredClaim`) explicitly refuse to release or re-try any attempt in `UNCERTAIN` state or where `metaRequestStartedAt` is set. Automatic retransmission is completely blocked.

4. **Status Reconciliation Monotonicity (ERA2-08):**
   - Status updates are monotonically reconciled: terminal states (`READ`, `DELIVERED`) cannot be downgraded by out-of-order `SENT` events or duplicate callbacks.

5. **Broadcast Campaigns & Cancellation Safety (ERA2-09 & ERA2-11):**
   - Broadcast recipients are claimed atomically.
   - Campaign cancellation transitions status to `CANCELLED`; worker and dispatcher verify status before claiming recipients, guaranteeing that cancellation prevents further Meta sends even during worker restart or outbox replay.

6. **Tenant Isolation (ERA2-11 & ERA2-11A):**
   - Multi-tenant data structures (`Contact`, `Conversation`) are scoped to `tenantId`.
   - All worker payloads authenticate `tenantId`, `wabaAccountId`, and `phoneNumberId` correlation before performing database operations.
   - Cross-tenant payloads or forged references are rejected with tenant authorization errors without external side effects.

---

## 5. New Tests Added & Findings

### `test/integration/observability-failure-isolation.test.ts`
- **Objective:** Certify read-only guarantees and failure isolation of the queue and outbox observability endpoints on live Redis and PostgreSQL.
- **Findings:**
  - Real Redis queue metrics return `available: true` across all 4 production queues (`wa-webhook-inbound`, `wa-message-outbound`, `wa-status-reconciliation`, `wa-broadcast-dispatch`).
  - Real PostgreSQL outbox metrics return `available: true` with non-null structured counts and accurate `UNCERTAIN` state classification.
  - Read-only invariant holds: repeated queries to observability endpoints produce zero state mutations, zero row creations/deletions, and zero timestamp alterations on `OutboundSendAttempt` or `OutboxEvent`.
  - Redis outage isolation holds: when Redis is unreachable, queue metrics report `available: false` with explicit error descriptions (no false zero job counts), while PostgreSQL outbox observability continues to return live data.
  - PostgreSQL outage isolation holds: when database queries fail, outbox metrics report `available: false` with error name (no false zeros), while Redis queue observability continues to return live data.

---

## 6. Execution Evidence & Quality Gates

### Unit Test Suite
- **Command:** `npm run test` (Vitest v5.0.0)
- **Result:** 59 test files passed (59), 577 tests passed (577), 0 failed
- **Exit Code:** 0

### Static Analysis & Typecheck
- **Lint Command:** `npm run lint` (ESLint) — Exit Code: 0 (clean)
- **Typecheck Command:** `npx tsc --noEmit` — Exit Code: 0 (clean)
- **Prisma Validation:** `npx prisma validate` — Exit Code: 0 (The schema at prisma/schema.prisma is valid)

### Production Build
- **Build Command:** `npm run build` (Next.js 16.3.4 Turbopack)
- **Result:** Compiled successfully, Prisma client generated, all 47 routes compiled
- **Exit Code:** 0

### Real Infrastructure Integration Suites (Sequential Execution)
| Suite | Command | Checks | Exit Code |
|---|---|---|---|
| Redis Failure Handling | `npx tsx test/integration/redis-failure-handling.test.ts` | 7/7 | 0 |
| Redis Integration | `npx tsx test/integration/redis-integration.test.ts` | 11/11 | 0 |
| BullMQ Integration | `npx tsx test/integration/bullmq-integration.test.ts` | 17/17 | 0 |
| BullMQ Producers | `npx tsx test/integration/bullmq-producers.test.ts` | 12/12 | 0 |
| Outbox PostgreSQL | `npx tsx test/integration/outbox-postgres.test.ts` | 7/7 | 0 |
| Outbox Dispatch | `npx tsx test/integration/outbox-dispatch.test.ts` | 5/5 | 0 |
| Stalled Job Recovery | `npx tsx test/integration/stalled-job-recovery.test.ts` | 17/17 | 0 |
| Outbound Attempt PostgreSQL | `npx tsx test/integration/outbound-attempt-postgres.test.ts` | 23/23 | 0 |
| Inbound Outbox | `npx tsx test/integration/inbound-outbox.test.ts` | 7/7 | 0 |
| Inbound Worker | `npx tsx test/integration/inbound-worker.test.ts` | 8/8 | 0 |
| Outbound Worker | `npx tsx test/integration/outbound-worker.test.ts` | 17/17 | 0 |
| Status Outbox | `npx tsx test/integration/status-outbox.test.ts` | 5/5 | 0 |
| Status Worker | `npx tsx test/integration/status-worker.test.ts` | 6/6 | 0 |
| Broadcast Outbox | `npx tsx test/integration/broadcast-outbox.test.ts` | 12/12 | 0 |
| Broadcast Worker | `npx tsx test/integration/broadcast-worker.test.ts` | 21/21 | 0 |
| Typing Indicator | `npx tsx test/integration/typing-indicator.test.ts` | 16/16 | 0 |
| Tenant Contact Identity | `npx tsx test/integration/tenant-contact-identity.test.ts` | 3/3 | 0 |
| Tenant Migration Rehearsal | `npx tsx test/integration/tenant-identity-migration-rehearsal.test.ts` | 13/13 | 0 |
| Observability Failure Isolation | `npx tsx test/integration/observability-failure-isolation.test.ts` | 13/13 | 0 |
| **Total** | **19 Integration Suites** | **217 / 217** | **0** |

---

## 7. Defects & Corrections

- **Defects Discovered:** 0 functional defects. All certified ERA 2 pipelines conformed strictly to the invariant specifications.
- **Corrections Made:** Added real-infrastructure integration coverage in `test/integration/observability-failure-isolation.test.ts` to bridge the gap between unit mocks and live database/Redis observability error handling.

---

## 8. Remaining Risks and Limitations

1. **Local Integration vs. Production Deployment:**
   - Local integration tests run against standalone PostgreSQL and single-instance Redis. High-availability Redis Sentinel/Cluster, read-replicas, and distributed network partitions require stage-environment verification.
2. **Meta API Boundary:**
   - Tests do not make real HTTP calls to Meta's Cloud API endpoints (mocked using GraphRequest / GraphFetch boundaries). Live Meta webhook delivery and outbound message sending remain subject to Meta SLA and credentials validation.
3. **Async Feature Flags:**
   - As required by the ERA 2 charter, all asynchronous queue flags remain disabled by default in production configuration.

---

## 9. Recommendation for WA-ERA2-14

All ERA 2 architectural, safety, idempotency, and recovery requirements have passed with complete deterministic evidence. The async pipeline foundation is technically certified.

**Recommendation:** Proceed to **WA-ERA2-14-FINAL-CERTIFICATION** for formal ERA 2 freeze assessment.
