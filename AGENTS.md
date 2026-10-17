# AGENTS.md — WhatsApp Business Admin

> Contract for all AI coding agents (including OpenCode). Read this file and `docs/adr/README.md` before proposing or changing code. This file describes the **target project**, not permission to implement its roadmap.

## 1. Identity and mission

**Project:** `whatsapp-business-admin` (fork of an existing project; upstream owner/URL and commit must be recorded before the first implementation). **Known baseline from a supplied static analysis:** v0.1.1, Next.js ^16.3.4, React 19, TypeScript 6, Node.js >=24 <25, PostgreSQL 16, Prisma 7, WhatsApp Cloud API, native WebSocket server. The repository itself has **not** been independently inspected by this document set.

**Mission:** maintain and evolve a self-hosted operational control plane for the official Meta WhatsApp Business Cloud API: connectivity, inbound/outbound messaging, operator inbox, status reconciliation, templates, contacts, observability, and controlled delivery of events to external consumers. Preserve and improve existing features rather than rewriting from scratch.

**Explicit boundaries:** This product is NOT a CRM, AI sales agent, autonomous agent framework, chatbot engine, workflow orchestrator, ERP, or replacement for Meta's Cloud API. Frappe/CRM, Mastra, n8n and other services are **external consumers/producers through explicit contracts**; do not embed their business logic in this repository. WhatsApp Flows and template/broadcast functionality already present in the baseline remain in scope for maintenance; do not mistake them for authorization to build a generic automation engine.

## 2. Binding architectural decisions

Read ADRs in `docs/adr/` and honor their statuses. A **Proposed** ADR is not authorization to implement. In case of conflict: current explicit user instruction > Accepted ADR > this file > scoped task packet > older notes; report any conflict before changing files. Do not silently reinterpret scope.

- ADR-0001: baseline inventory (Recorded; observations require source verification).
- ADR-0002: product scope and integration boundaries (Accepted).
- ADR-0003: native runtime, **NO Docker** (Accepted).
- ADR-0004: tenant-aware domain without full SaaS (Accepted at principle level; detailed schema is not approved).
- ADR-0005: Redis/BullMQ and delivery reliability (Proposed; implementation not yet approved).
- ADR-0006: event envelope and webhook relay (Proposed; implementation not yet approved).
- ADR-0007: change governance and execution gate (Accepted).

## 3. Non-negotiable runtime requirements

Use **native services** on a Linux host: Node.js 24 (matching package requirements), PostgreSQL 16, and **Redis only after ADR-0005 is accepted for implementation**. For deployed long-running app/worker services prefer systemd. Use OS packages/services or explicitly approved native installers, with locked versions and reproducible setup documentation. A local reverse proxy (e.g. Nginx or HAProxy) may be chosen in a separate deployment decision.

**Prohibited by default:** Docker, Docker Compose, container images as deployment requirements, Kubernetes, container-only CI dependencies, hidden cloud queues/databases, or replacing the runtime stack. An existing `docker-compose.yml` may remain as upstream reference; do not use, extend, or prescribe it as the supported deployment path. Do not delete upstream artifacts without permission.

## 4. Hard architecture constraints

1. **Meta is authoritative for platform delivery outcomes**; avoid fabricating sent/delivered/read states. Persist evidence and reconcile idempotently.
2. **PostgreSQL is the durable system of record.** Do not treat process memory, Redis Pub/Sub, or WebSocket as durable storage.
3. **Durable delivery:** never assume exactly-once external delivery. Use stable event IDs, idempotent handlers, retry bounds, eventual reconciliation and explicit failure visibility. A design must close the DB-to-queue crash window (e.g. transactional outbox) before claiming guarantees.
4. **Tenant isolation:** treat tenant and WhatsApp assets (WABA/phone number) as explicit domain concepts; do not assume one WABA per installation in new work. No automatic migrations of existing data without an approved backfill and rollback plan.
5. **Realtime transports events, not truth:** websocket clients recover state from authenticated APIs after disconnects.
6. **Security by default:** validate webhook signatures using raw request bytes; redact tokens/PII in logs; encrypt secrets at rest; authorize every API and websocket subscription at tenant/resource level; never cross tenant boundaries.
7. **Preserve legacy compatibility:** migrations, endpoint/API semantics, persisted data and current operator workflow must not break without explicit acceptance and transition plan.
8. **No silent stack swaps:** retain Next.js, React, TypeScript, PostgreSQL, Prisma, `ws` unless an accepted ADR says otherwise.

## 5. Work authorization: one unit at a time

Only perform the concrete task explicitly requested. ADR roadmap items are plans, **not active tasks**. Before making code changes, supply a short PRE-FLIGHT including: (a) task ID and expected files, (b) baseline evidence from actual repo, (c) boundaries and acceptance criteria, (d) tests and migration/rollback strategy, (e) open blocking questions. If required evidence is unavailable, mark UNKNOWN and stop at analysis; never invent repo contents or report unrun tests as PASS.

Changes to schema, auth, multi-tenancy, queueing, webhook semantics, outbound messaging, deployment services, or public API require a dedicated approved implementation unit. No drive-by refactors, framework updates, package upgrades, mass formatting or unrelated feature work. Ask before installing software, modifying production services, changing secrets or performing destructive migrations.

## 6. Quality gates and reporting

For each approved implementation: add/update automated tests for changed behavior; run available typecheck/lint/tests/build relevant to the task; check `git diff --check`; ensure secrets are absent from diff/logs; document compatibility, migrations, rollback and manual verification. For multi-tenant changes include negative cross-tenant tests. For queues/webhooks include duplicate, restart, retry, timeout, ordering and poison-message cases as appropriate. If any gate cannot run, record **NOT RUN** with reason (never PASS).

Mandatory completion report:

```text
TASK_ID:
STATUS: PASS | FAIL | BLOCKED
BASELINE_COMMIT:
FILES_CHANGED:
DECISIONS_REFERENCED:
SUMMARY:
TESTS_RUN_AND_RESULTS:
SECURITY_AND_TENANT_CHECKS:
MIGRATION_AND_ROLLBACK:
OPEN_RISKS:
OUT_OF_SCOPE_CHANGES: NONE | details
```

## 7. Immediate priority

First verify the fork against the supplied baseline and record its upstream URL, branch and commit, then formalize the ADRs. **Do not implement WA-01 or queue/realtime changes until separately authorized.** The current documentation package is a project charter and decision record, not runnable deployment instructions.

## 8. Local dev server lifecycle

Use the project scripts, do not invent ad-hoc commands.

- Default / production-dev environment (port 4020):
  `./scripts/dev.sh start | stop | restart | status`
  - Kills any running `tsx watch server.ts` / `tsx server.ts`, clears `.next-dev`, starts `npm run dev` in background, waits up to 20s for `:4020` to listen, prints pid.
  - `stop` is the only safe way to terminate a running instance. Do not run `nohup npm run dev` directly while a previous instance is alive.

When the user says "levanta el servicio", "start the server", "apaga el servicio" or similar, prefer these scripts over manual `nohup tsx server.ts` invocations. They handle pid files, port collision and log paths consistently and are the supported entry points.

## 9. UI work: mandatory visual contract

Before modifying any UI component, page, or screen, consult `docs/ui/visual-contract.md` — the authoritative visual contract for this project. The contract formalizes the active patterns (PageHeader, Card, Button, Table, tokens, states) and defines exceptions.

**Rules for any UI task:**

1. **Locate the contract first** — `docs/ui/visual-contract.md` is the single source of truth for visual conventions. Read it before editing any screen.
2. **Inspect existing patterns** — check the active implementation of the target screen before modifying. Compare against the contract.
3. **Reuse existing components** — use `src/components/ui/` and `src/components/shell/` primitives. Do not create parallel components.
4. **Do not invent local patterns** — if the contract covers a case, follow it. New visual patterns require explicit task scope.
5. **Preserve documented exceptions** — Inbox uses a three-column full-height layout; it is explicitly exempt from the administrative page pattern. Flows and complex builders may have specialized layouts.
6. **Limit scope to one screen or flow** — unless the task explicitly authorizes broader scope. Avoid mixing UI and backend changes.
7. **Verify visually** — after any UI change, confirm the result looks correct on desktop and mobile (375px viewport).
8. **Consider all breakpoints** — mobile (< 640px), tablet (640-1023px), desktop (≥ 1024px). Usable content matters more than no overflow.
9. **Do not mix backend work during WA-UI-CLOSURE** — unless a technical need is demonstrated. Keep UI and backend work in separate tasks.
10. **Do not declare a screen complete solely because it compiles or tests pass** — visual verification is required.

## 11. Tenant terminology in Spanish UI

**Convention:** In Spanish UI, the technical term "tenant" must appear as "organización" (singular) and "organizaciones" (plural).

- Tenant → Organización
- Tenants → Organizaciones
- New tenant → Nueva organización
- Create tenant → Crear organización

Applies only to user-visible text in Spanish. Does not affect code, APIs, routes, schemas, identifiers, or technical contracts.

**Visual vs. functional completion:** A screen can be visually finished while its backend is still pending. Pending-functional controls must not fake success (no mock success toasts, no fake data shown as production).
