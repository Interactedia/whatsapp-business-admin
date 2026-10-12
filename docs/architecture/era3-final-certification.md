# ERA 3 — Final Certification and Freeze Record

**Task ID:** WA-ERA3-CERT
**Status:** FROZEN
**Date:** 2026-10-12
**Certification commit (HEAD):** `66eb3f17cf03159d966a505a0447e0773ea53589`
**Pre-certification baseline (WA-ERA3-07):** `a3c30f9` (88-check integration certification)
**Frozen code boundary:** `66eb3f1` (WA-ERA3-07-SECURITY-REMEDIATION; last commit touching production code)
**Freeze record completion:** documentation-only commits after this record do not alter the frozen code boundary (no production code changed after `66eb3f1`).
**Certification Layer:** layer-3-premium
**Executor:** autonomous implementation

---

## 1. Repository Baseline Verification

| Check | Result |
|---|---|
| Git branch | `main` |
| Ahead of `origin/main` | 36 commits |
| Pre-certification baseline (WA-ERA3-07) | `a3c30f9` (88-check integration certification) |
| Certification commit (HEAD) | `66eb3f17cf03159d966a505a0447e0773ea53589` |
| Worktree state | Clean (no uncommitted changes) |
| Merge conflicts | None |
| Pre-existing changes | None |
| `git diff --check` | PASS |

The frozen code boundary is `66eb3f1`. The certification commit (HEAD) is identical to the frozen code boundary because no production code changed after the security remediation; only the certification document is added by this task. The terminal frozen commit is identified in the WA-ERA3-CERT execution RUN_REPORT.

---

## 2. ERA 3 Iteration Certification Matrix

| Iteration | Task ID | Status | Evidence |
|---|---|---|---|
| ERA3-01 | WA-ERA3-01 | PASS — Canonical External Event Contract v1 | `src/lib/events/contract.ts`, `src/lib/events/validation.ts`, `docs/architecture/era3-canonical-event-contract.md` |
| ERA3-02 | WA-ERA3-02 | PASS — Canonical Event Production | `src/lib/events/producers/canonical.ts`, `docs/architecture/era3-canonical-event-production.md` |
| ERA3-03 | WA-ERA3-03 | PASS — Durable Canonical Outbox | `src/lib/events/outbox.ts`, `prisma/migrations/20261011190000_add_canonical_event_outbox/`, `docs/architecture/era3-durable-event-outbox.md` |
| ERA3-04 | WA-ERA3-04 | PASS — Canonical HTTP Delivery Worker | `src/lib/events/delivery.ts`, `docs/architecture/era3-delivery-worker.md` |
| ERA3-05 | WA-ERA3-05 | PASS — Retry, Idempotency, Failure Handling | `src/lib/events/delivery-state.ts`, `src/lib/events/retry-policy.ts`, `docs/architecture/era3-delivery-reliability.md` |
| ERA3-06 | WA-ERA3-06 | PASS — Webhook Destinations and Security | `src/lib/events/webhook-destinations.ts`, `src/lib/events/webhook-signing.ts`, `docs/architecture/era3-webhook-destinations.md` |
| ERA3-07 | WA-ERA3-07 | PASS — Canonical Relay Integration Certification | `test/integration/era3-integration-certification.test.ts`, `docs/architecture/era3-integration-certification.md` |
| ERA3-07-FANOUT | WA-ERA3-07-FANOUT | PASS — Post-commit Subscription Fanout (commit `b5f8e40`) | `src/lib/events/fanout.ts`, `docs/architecture/era3-subscription-fanout.md` |
| ERA3-07-SECURITY-REMEDIATION | WA-ERA3-07-SECURITY-REMEDIATION | PASS — Atomic endpoint-change suspension (commit `66eb3f1`) | `prisma/migrations/20261012160000_add_suspended_delivery_state/`, hardened `webhook-destinations.ts` / `delivery-state.ts` / `delivery.ts` |

---

## 3. Component Inventory (ERA 3)

### 3.1 Canonical Event Domain
- `src/lib/events/contract.ts` — `EXTERNAL_EVENT_CONTRACT_VERSION = 1`, four event families:
  - `inbound.message.received`
  - `outbound.message.accepted`
  - `outbound.message.status_changed`
  - `conversation.changed`
- `src/lib/events/validation.ts` — strict zod-based validation; rejects cross-tenant events, secrets, raw Meta payloads, and PII.
- `src/lib/events/producers/canonical.ts` — authoritative event production per business transition.

### 3.2 Transactional Persistence
- `src/lib/events/outbox.ts` — `addCanonicalEvent` with stable JSON, deterministic SHA-256 payload hash, transactional outbox, idempotency by `eventId`.
- `prisma/schema.prisma` — `CanonicalEventOutbox` model.
- `prisma/migrations/20261011190000_add_canonical_event_outbox/` — additive migration.

### 3.3 Tenant Authorization
- Tenant ownership enforced at every layer (production, validation, fanout, delivery, administration).
- Authorization surfaces under `src/app/api/tenants/[tenantId]/webhook-destinations/**` — 8 routes (list, create, get, update, delete, suspend, resume, test).
- Negative cases covered: cross-tenant access rejected, AGENT role rejected for administration, SYSTEM_ADMIN can only act within own tenant (per existing ERA 2 enforcement).

### 3.4 Subscription Fanout
- `src/lib/events/fanout.ts` — `fanoutCanonicalEvent`: explicit post-commit fanout, eligibility filter (same tenant, `enabled=true`, `retiredAt=null`, event type in `subscriptions`), idempotent by `@@unique([tenantId, eventId, destinationId])`.

### 3.5 Durable Delivery Coordination
- `src/lib/events/delivery-state.ts` — lease-based `claimDelivery`, fencing of stale workers, retry/terminal state machine, `SUSPENDED` state (added by WA-ERA3-07-SECURITY-REMEDIATION).
- `prisma/schema.prisma` — `CanonicalEventDelivery`, `CanonicalEventDeliveryAttempt` models.
- `prisma/migrations/20261012000000_wa_era3_delivery_state/` and `20261012160000_add_suspended_delivery_state/`.

### 3.6 HTTP Transport Security
- `src/lib/events/delivery.ts` — `deliverCanonicalEventHttp`: HTTPS enforced, redirect rejected, DNS connection-time pin, HMAC-SHA256 v1 signing, connection target validation, fixed 5-second timeout for tests, injectable `transport` seam.
- `src/lib/events/webhook-signing.ts` — `signWebhookBody`, `verifyWebhookSignature` with `crypto.timingSafeEqual` and timestamp tolerance.
- `src/lib/events/webhook-destinations.ts` — `isUnsafeWebhookUrl` rejects `localhost`, `127.0.0.1`, `::1`, `.localhost`, URLs with credentials; HTTPS protocol required; SSRF protections validated.

### 3.7 PostgreSQL Migrations
- All additive migrations applied; schema up to date.
- 21 migrations total (count at certification time).

### 3.8 Integration Verification
- `test/integration/era3-integration-certification.test.ts` — 88 checks against real PostgreSQL and controlled HTTP receivers.

### 3.9 Release Documentation
- `docs/architecture/era3-canonical-event-contract.md`
- `docs/architecture/era3-canonical-event-production.md`
- `docs/architecture/era3-durable-event-outbox.md`
- `docs/architecture/era3-delivery-worker.md`
- `docs/architecture/era3-delivery-reliability.md`
- `docs/architecture/era3-webhook-destinations.md`
- `docs/architecture/era3-subscription-fanout.md`
- `docs/architecture/era3-integration-certification.md`
- `docs/architecture/era3-final-certification.md` (this record)

---

## 4. Contract Versions

| Contract | Version | Source |
|---|---|---|
| ExternalEvent | v1 (`EXTERNAL_EVENT_CONTRACT_VERSION = 1`) | `src/lib/events/contract.ts` |
| Webhook Signature | v1 (`WEBHOOK_SIGNATURE_VERSION = "v1"`) | `src/lib/events/webhook-signing.ts` |
| Prisma schema | at certification time: 21 migrations applied | `prisma/migrations/`, `npx prisma migrate status` |

ExternalEvent v1 is unchanged. No new event families introduced.

---

## 5. Database Migration Baseline

| Migration | Purpose |
|---|---|
| `20261011190000_add_canonical_event_outbox` | ERA 3-03 — outbox table |
| `20261012000000_wa_era3_delivery_state` | ERA 3-05 — delivery & attempt state machines |
| `20261012000000_webhook_destinations` | ERA 3-06 — destinations, subscriptions, signing secret ciphertext |
| `20261012160000_add_suspended_delivery_state` | ERA 3-07-SECURITY-REMEDIATION — `SUSPENDED` state + `deliverySuspensionUrl` |

All additive, non-destructive. `npx prisma migrate status` reports schema up to date.

---

## 6. Test Commands and Results

| Suite | Command | Expected | Actual |
|---|---|---|---|
| ERA 3 integration certification | `npx tsx test/integration/era3-integration-certification.test.ts` | 88/88 PASS | **88/88 PASS** (real PostgreSQL + HTTP receivers) |
| Unit tests (vitest) | `npm test` | 695/695 | **695/695 PASS** (65 files, 3.74s) |
| Typecheck | `npx tsc --noEmit` | PASS | **PASS** (0 errors) |
| Lint | `npm run lint` | PASS | **PASS** (0 warnings) |
| Prisma validate | `npx prisma validate` | PASS | **PASS** |
| Prisma migrate status | `npx prisma migrate status` | "Database schema is up to date" | **PASS — Database schema is up to date!** (21 migrations) |
| Git diff check | `git diff --check` | PASS | **PASS** (no output) |
| Production build | `npm run build` (with `.next-prod` cleared) | PASS | **PASS** (Next.js 16, all routes built) |

ERA 2 regressions are included in the 695/695 unit suite. The ERA 3 integration suite exercises all four canonical event families, outbox durability, fanout eligibility + idempotency, HMAC verification, retry/recovery, lease fencing, tenant isolation, destination lifecycle, URL-change suspension, DNS connection-time safety, and external consumer interoperability.

---

## 7. Security Guarantees (as certified)

1. **HTTPS enforcement** — non-HTTPS webhook endpoints rejected by `webhookDestinationInputSchema`.
2. **HMAC signing** — every HTTP delivery carries `X-WBA-Signature: v1=<hex>` and `X-WBA-Timestamp`; receivers verify with `crypto.timingSafeEqual` and 5-minute timestamp tolerance.
3. **Secret protection** — signing secrets stored encrypted at rest (`WebhookDestination.signingSecretEnc`); never echoed through API responses; protected with `ENCRYPTION_KEY` (AES-256-GCM).
4. **SSRF rejection** — `isUnsafeWebhookUrl` blocks `localhost`, `127.0.0.1`, `::1`, `.localhost`, URLs with embedded credentials.
5. **DNS connection-time safety** — `deliverCanonicalEventHttp` resolves at delivery time, pins the TCP connection to the resolved address (`lookup all: true`, `family: 0`), and rejects any change.
6. **Redirect rejection** — HTTP 3xx responses from destinations are classified as `REJECTED` and never re-target.
7. **Tenant ownership** — every destination is tenant-scoped; cross-tenant fanout and administration rejected.
8. **Administrative authorization** — destination create/update/suspend/resume require tenant admin; AGENT role rejected; SYSTEM_ADMIN limited to own tenant.
9. **Atomic endpoint-change suspension** — URL update and delivery suspension commit in one `prisma.$transaction`; replaced URL recorded for confirmation; if any step fails, neither takes effect.
10. **No silent recipient redirect** — `POST /suspended` requires explicit current-URL confirmation and `acknowledgeRecipientChange=true` when the recipient changed.

---

## 8. Tenant Isolation Guarantees

- Cross-tenant events are invalid by contract (`validateExternalEvent` rejects).
- Fanout filters by exact `tenantId` match.
- Delivery row uniqueness is `@@unique([tenantId, eventId, destinationId])`; cross-tenant never materializes a delivery.
- Destination APIs are mounted under `/api/tenants/[tenantId]/...` and authorize every call.
- Webhook receivers see only the tenant of the delivery attempt.

---

## 9. Delivery Semantics

- **At-least-once** delivery over HTTPS. Exactly-once is not claimed; receivers must implement idempotency.
- **One logical delivery** per `(tenantId, eventId, destinationId)`. Database uniqueness is the source of truth.
- **Lease-based claiming** with 45-second default lease. Stale workers are fenced.
- **Retry policy** via `retry-policy.ts` (exponential backoff with jitter, bounded by `maxAttempts`).
- **Terminal failure** on `maxAttempts` exceeded; recorded in `CanonicalEventDeliveryAttempt` history; never deleted.
- **Historical delivery records** preserved across URL change, secret rotation, and destination retirement.

---

## 10. Known Limitations

1. **No automatic production dispatch.** `fanoutCanonicalEvent` and `deliverCanonicalEventHttp` are invoked only from tests, the `/test` API route, and any future explicit orchestration.
2. **Explicit invocation required.** Production fanout and delivery require an external orchestrator (out of scope for ERA 3).
3. **At-least-once delivery.** Receivers must deduplicate by canonical event `id`.
4. **Consumer-side idempotency is necessary.** The contract is stable; the transport is not.
5. **Mastra/n8n live integration is not claimed.** The relay is certified generic; downstream consumer libraries are out of scope.
6. **Production deployment is not certified by local integration tests.** The 88-check suite runs against the local PostgreSQL at `localhost:5434` and locally bound HTTP receivers. Staging/prod equivalent is not within this certification's evidence.
7. **ExternalEvent v1 only.** No v2 planned; v1 is the durable contract.

---

## 11. Production Activation Status

**Production automatic dispatch: OFF.**

No automatic process invokes canonical fanout or delivery dispatch. Verified:
- No `setInterval` / `setTimeout` / `cron` / `systemd timer` in `src/lib/events/**` or `server.ts` that triggers `fanoutCanonicalEvent`, `claimDelivery`, or `deliverCanonicalEventHttp`.
- No `src/app/api/**` route invokes fanout or delivery as a side effect.
- The only invocation surface is the explicit `/test` endpoint and the integration tests.

The canonical relay is **certified**. **Automatic production dispatch remains OFF** until a separate operational authorization is issued.

---

## 12. Accepted Commit Lineage (ERA 3)

```
66eb3f1 fix(events): WA-ERA3-07-SECURITY-REMEDIATION atomic endpoint-change suspension
2c4b339 feat(messages): WA-REMEDIATION-1A add external outbound idempotency
3687d8b feat(events): suspend pending deliveries on webhook URL change
a3c30f9 test(events): WA-ERA3-07 certify canonical webhook relay end-to-end
b5f8e40 feat(events): WA-ERA3-07-FANOUT add post-commit subscription fanout
81e634e test(events): WA-ERA3-06 certify webhook destinations
f306afc feat(events): WA-ERA3-06 add tenant webhook destinations
60b0582 feat(events): WA-ERA3-05 add durable delivery state
2b09ab6 feat(events): WA-ERA3-04 add canonical event HTTP delivery worker
b0d17f9 feat(events): WA-ERA3-03 add durable canonical outbox
07c8673 feat(events): WA-ERA3-02 add canonical event producers
dadf8de feat(events): WA-ERA3-01 define canonical external event contract
```

ERA 2 baseline (frozen): `dc8e84f23bd5dfd9c48a912beb5f2384967b5555` (WA-ERA2-14).

---

## 13. Final Repository Baseline

| Field | Value |
|---|---|
| Branch | `main` |
| HEAD SHA | `66eb3f17cf03159d966a505a0447e0773ea53589` |
| Worktree | clean |
| Pre-existing changes | none |
| Ahead of `origin/main` | 36 commits |
| Migration count | 21 applied |
| Unit test count | 695 |
| Integration checks (ERA 3) | 88 |
| Production build | clean |
| Lint | clean |
| Typecheck | clean |
| `git diff --check` | clean |

---

## 14. ERA 3 Freeze Declaration

> **ERA 3 is FROZEN as of `66eb3f17cf03159d966a505a0447e0773ea53589` on `main`.**
>
> All accepted ERA 3 units (WA-ERA3-01 through WA-ERA3-07, plus WA-ERA3-07-FANOUT and WA-ERA3-07-SECURITY-REMEDIATION) are integrated, tested, and consistent. ERA 2 remains FROZEN. ExternalEvent v1 is unchanged. The canonical relay is certified but automatic production dispatch remains **OFF** until a separate operational authorization is issued.
>
> No code change to the frozen boundary is allowed without a new accepted implementation packet. Documentation-only updates to this record are permitted.

---

## 15. Out of Scope for ERA 3 Freeze

The following are explicitly excluded from the ERA 3 freeze and remain future work:

- Automatic production dispatch activation.
- Production scheduler / cron / systemd timer.
- New Redis queues.
- New WebSocket infrastructure for canonical events.
- New canonical event types.
- ExternalEvent v2.
- Modifications to ERA 2 (frozen).
- CRM integration (Frappe, etc.).
- Mastra-specific functionality.
- n8n-specific functionality.
- Automation Control.
- Human handoff.
- Recipient-number blocking.
- New Inbox functionality.
- New UI features.
- Unrelated refactoring or framework upgrades.
- Infrastructure deployment / staging / production.

---

## 16. Operational Limitations (current certified state)

- The certified relay accepts explicit invocations only.
- The certified delivery path is at-least-once.
- The certified contract is ExternalEvent v1; the canonical envelope will not silently grow.
- The certified persistence is PostgreSQL; no in-memory or Redis-only state is the source of truth.
- The certified security is HTTPS + HMAC v1 + signed body + SSRF/DNS pin + redirect rejection + admin-gated operations.

Any new operational capability requires a new accepted implementation packet and a new certification cycle.
