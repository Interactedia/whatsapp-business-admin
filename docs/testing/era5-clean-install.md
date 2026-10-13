# ERA 5 — Clean Install Baseline

WA-ERA5-00 result. Establishes a fully isolated test environment and
documents the first-run behavior of WhatsApp Business Admin against a
clean PostgreSQL database, distinct from any pre-existing environment.

## Scope

Reproducible, non-destructive isolation for ERA 5 functional testing.
Preserves the previous database (`wa_admin`) and the default BullMQ
namespace (`wa-queue`) untouched.

## Out of scope

- Destructive cleanup of any existing database or Redis key.
- Auto-seeding of demo tenants, users, or conversations.
- Schema changes, new migrations, or `prisma db push`.
- Docker.
- External WhatsApp calls.
- Any change to FROZEN ERAs 1/2/3/4.

---

## 1. Test environment

Created on the same PostgreSQL server that hosts `wa_admin`, but
logically and physically separated.

| Item                     | Value                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------- |
| New database             | `whatsapp_era5_test`                                                               |
| Server (logical)         | `localhost:5434` → container `172.19.0.2:5432`                                     |
| Database user            | `wa`                                                                               |
| Encoding                 | UTF8                                                                               |
| Owner                    | `wa`                                                                               |
| Pre-existing databases   | `wa_admin` (UNCHANGED)                                                             |
| Application port         | `4030` (was `4020` for the dev instance, now free)                                 |
| Redis URL                | `redis://127.0.0.1:6379` (shared server, isolated namespace)                       |
| BullMQ namespace prefix  | `wa-queue-era5` (default app uses `wa-queue` — collision-free)                     |
| BullMQ worker concurrency| `1` (default app uses `5` — isolated load)                                        |
| Auth.js AUTH_URL         | `http://localhost:4030` (no ngrok tunnel in this test)                             |
| App config file          | `.env.era5` (sourced only by the ERA 5 launcher)                                   |

### Isolation strategy

- **Database:** a brand-new database `whatsapp_era5_test` was
  provisioned. The previous `wa_admin` database was never connected to,
  never modified, and never read by the ERA 5 process. Migrations were
  applied **only** against `whatsapp_era5_test`.
- **Redis / BullMQ:** BullMQ already supports a `BULLMQ_PREFIX` env var
  (`src/lib/queue/config.ts:49`). ERA 5 sets
  `BULLMQ_PREFIX=wa-queue-era5`, which produces a fully separate key
  namespace. The pre-existing `wa-queue:*` keys are untouched. The
  Redis Pub/Sub realtime channel still uses the same server but is
  logically distinct from queue keys.
- **Authentication:** Auth.js v5 uses the same `AUTH_SECRET` value
  family but a different `AUTH_URL` (no tunnel). The first-run login
  page is shown — there are no users yet in the clean DB.
- **Seed scripts:** the existing `prisma/seed.ts` has a built-in safety
  guard (`SEED_ADMIN_PASSWORD` is required unless
  `WBA_ALLOW_DEMO_SEED=true` is set). The ERA 5 env sets neither, so
  the seed script cannot run against this environment by accident.

### Files added

- `.env.era5` — test-only env config.
- `scripts/era5-start.sh` — launcher that sources `.env.era5`, kills
  any prior instance, clears `.next-dev`, and starts `tsx server.ts`.
- `scripts/era5-browser-smoke.ts` — Playwright first-run smoke test.
- `docs/testing/era5-clean-install.md` — this file.

No existing source files were modified.

---

## 2. Pre-existing database preservation evidence

Row counts captured **before** any ERA 5 action.

| Table         | Rows |
| ------------- | ---: |
| Tenant        |   29 |
| User          |    6 |
| WabaAccount   |   14 |
| PhoneNumber   |   12 |
| Contact       |   11 |
| Conversation  |    7 |
| Message       |   44 |
| ApiKey        |    1 |
| ApiLog        |   70 |
| WabaSettings  |    2 |
| WebhookEvent  |  112 |
| CanonicalEventOutbox | 8 |
| TenantMembership   | 6 |
| OutboundSendAttempt | 4 |
| Broadcast / Template / Flow tables | 0 |

After the full ERA 5 run, the **same row counts** were re-verified
against `wa_admin` — identical to the snapshot above. The pre-existing
database was not touched.

---

## 3. New database: clean state after migrations

`npx prisma migrate deploy` against `whatsapp_era5_test` applied all
**21 migrations** from `prisma/migrations/`:

```
20260724080417_init
20260724081623_add_meta_app_id
20260724135623_add_api_keys
20260801120000_add_whatsapp_flows
20261009172000_add_tenant_waba_foundation
20261009173500_add_nullable_tenant_ownership_to_messaging
20261009180500_add_user_tenant_memberships
20261010120000_bind_conversations_to_phone_numbers
20261010184647_api_key_tenant
20261010193000_add_tenant_ownership_to_templates_flows_broadcasts
20261010200000_add_webhook_verify_token_to_waba_account
20261011_outbound_send_attempt
20261011120000_add_transactional_outbox
20261011143000_add_outbound_meta_request_started
20261011160000_add_broadcast_recipient_message_id
20261011180000_tenant_scoped_contact_conversation_identity
20261011190000_add_canonical_event_outbox
20261012000000_wa_era3_delivery_state
20261012000000_webhook_destinations
20261012150000_add_message_idempotency
20261012160000_add_suspended_delivery_state
```

`npx prisma migrate status` after deploy:

```
Datasource "db": PostgreSQL database "whatsapp_era5_test", schema "public" at "localhost:5434"
21 migrations found in prisma/migrations
Database schema is up to date!
```

`npx prisma validate`:

```
The schema at prisma/schema.prisma is valid 🚀
```

### Row counts in the new database

| Table            | Rows |
| ---------------- | ---: |
| Tenant           | 0 |
| User             | 0 |
| WabaAccount      | 0 |
| WabaSettings     | 0 |
| PhoneNumber      | 0 |
| Contact          | 0 |
| Conversation     | 0 |
| Message          | 0 |
| ApiKey           | 0 |
| ApiLog           | 0 |
| Template         | 0 |
| Broadcast        | 0 |
| BroadcastRecipient | 0 |
| Flow             | 0 |
| FlowVersion      | 0 |
| FlowLaunch       | 0 |
| FlowSubmission   | 0 |
| WebhookDestination | 0 |
| WebhookEvent     | 0 |
| CanonicalEventOutbox | 0 |
| CanonicalEventDelivery | 0 |
| OutboundSendAttempt | 0 |
| OutboxEvent      | 0 |
| TenantMembership | 0 |
| `_prisma_migrations` | 21 (metadata only) |

All business tables are empty. The only populated table is the Prisma
migration ledger. **Zero tenants, zero users, zero contacts, zero
conversations, zero messages, zero WABA accounts, zero webhook
subscriptions, zero persisted application jobs.**

---

## 4. Redis / BullMQ isolation

Pre-existing queue keys (default prefix, production-like app):

```
wa-queue:wa-message-outbound:meta
wa-queue:wa-webhook-inbound:meta
wa-queue:wa-broadcast-dispatch:meta
wa-queue:wa-status-reconciliation:meta
```

During ERA 5 startup, the application connected to Redis and enabled
Pub/Sub fan-out:

```
[realtime-pubsub] subscriber ready
[realtime-pubsub] subscribed (instanceId=wa-255172-mv618hns)
```

Connection seen from the host:

```
ESTAB  127.0.0.1:46330 → 127.0.0.1:6379
```

The BullMQ prefix `wa-queue-era5` is distinct from the default
`wa-queue`. No `FLUSHDB` / `FLUSHALL` was performed. No pre-existing
keys were deleted or modified. The shared Redis instance hosts both
namespaces side by side without conflict.

---

## 5. Application startup

`scripts/era5-start.sh` launched the dev server with the ERA 5 env.
Tail of `/tmp/era5-server.log`:

```
✓ Running next.config.mjs took 27ms
▶ Realtime fan-out: Redis Pub/Sub enabled
▶ WhatsApp Business Admin ready on http://0.0.0.0:4030 (dev=true)
[realtime-pubsub] subscriber ready
[realtime-pubsub] subscribed (instanceId=wa-255172-mv618hns)
```

Server bound `0.0.0.0:4030`. Auth.js v5, Prisma (`DATABASE_URL` from
`.env.era5`), and the WebSocket hub initialized without errors.

Smoke checks:

| Endpoint          | Status | Notes                                                  |
| ----------------- | -----: | ------------------------------------------------------ |
| `GET /`           | 307    | Redirects to `/login?callbackUrl=…`                    |
| `GET /login`      | 200    | Renders Email / Password / Sign in                      |
| `GET /users`      | 200    | Redirects to `/login?callbackUrl=…` (Auth.js gate)     |
| `GET /api/v1/templates` | 401 | Rejected without API key (no users exist anyway)   |
| `GET /api/auth/session` | 200 | Body: `null` (no active session)                   |

---

## 6. First-run browser evidence (real Chromium)

Driven by `scripts/era5-browser-smoke.ts` using Playwright
`@playwright/test` v1.64.0 (Chromium headless shell v156). Output in
`/tmp/era5-smoke/`:

- `01-root-redirect.png` — landing page redirects to `/login`.
- `02-login-page.png` — login form rendered.
- `03-after-submit.png` — credentials submitted, app displays
  "Iniciando sesión…", stays on `/login` (no user exists in clean DB).
- `04-protected-route.png` — `/users` redirects to `/login?callbackUrl=…`.

`observations.json` summary:

| Field                       | Value                                                                |
| --------------------------- | -------------------------------------------------------------------- |
| root status                 | 200 → `/login?callbackUrl=…`                                         |
| login status                | 200                                                                  |
| login form                  | email + password + submit button present                             |
| submit with no real user    | page shows "Iniciando sesión…", URL remains `/login`                 |
| protected route             | 200 → `/login?callbackUrl=/users`                                    |
| session API                 | `null` (no session)                                                  |
| console errors              | 0                                                                    |
| console warnings            | 0                                                                    |
| failed network requests     | 0                                                                    |

### Bootstrap observation

The application has **no built-in first-run administrator
bootstrap**. With an empty database, `/login` renders normally but no
credentials succeed because no `User` row exists. The intended
bootstrap path is to run `prisma db:seed` after migrations, but the
existing seed script:

- Creates two fixed tenants (`cmv337nob0001t25hbbyuq8tk` and `acme`).
- Creates three fixed users (`admin@superadmin.com`,
  `admin@default.com`, `admin@acme.com`) all with the same password
  `123456` unless overridden.
- Refuses to run unless `SEED_ADMIN_PASSWORD` is set or
  `WBA_ALLOW_DEMO_SEED=true`.

This is documented as a known gap for `WA-ERA5-01` — it is **not**
executed here because that is the explicit out-of-scope clause "Do not
automatically run them" in the implementation requirements.

---

## 7. Guardrails

| Gate                            | Command                              | Result |
| ------------------------------- | ------------------------------------ | ------ |
| Prisma schema validation        | `npx prisma validate`                | PASS   |
| Prisma migration status         | `npx prisma migrate status`          | PASS (DB up to date) |
| Prisma migration deploy         | `npx prisma migrate deploy`          | PASS (21 applied) |
| Database identity verification  | `pg_stat_activity` / `current_database()` | PASS (era5_test, not wa_admin) |
| Database row counts             | psql row counts on both DBs          | PASS (wa_admin unchanged, era5_test clean) |
| Redis namespace isolation       | `redis-cli KEYS "wa-queue*"`         | PASS (era5 prefix distinct) |
| Application health check        | `curl GET /login` → 200              | PASS   |
| Real Chromium smoke test        | Playwright + Chromium headless 156   | PASS (0 errors, screenshots saved) |
| TypeScript typecheck            | `npx tsc --noEmit`                   | PASS   |
| Lint                            | `npm run lint`                       | PASS (no warnings) |
| Build                           | `npm run build`                      | PASS   |
| Git diff sanity                 | `git diff --check`                   | PASS (no tracked files modified) |

---

## 8. Step status

| #  | Step                                                    | Status |
| -- | ------------------------------------------------------- | ------ |
| 1  | Existing database preserved                             | PASS   |
| 2  | New database provisioned safely                         | PASS   |
| 3  | Test `DATABASE_URL` verified                            | PASS   |
| 4  | Existing migrations applied successfully                | PASS (21/21) |
| 5  | Schema integrity                                        | PASS (`prisma validate` + `migrate status`) |
| 6  | No business records present                             | PASS (zero rows in 24 business tables) |
| 7  | Seed scripts reviewed (not run)                         | PASS   |
| 8  | Bootstrap requirements documented                       | PASS (no built-in admin bootstrap; seed is the only path and is opt-in) |
| 9  | Redis / BullMQ isolation verified                       | PASS (`wa-queue-era5` distinct from `wa-queue`) |
| 10 | Application started against test database               | PASS   |
| 11 | Real browser launched (Chromium 156)                    | PASS   |
| 12 | First-run behavior recorded (4 screenshots + JSON)     | PASS   |
| 13 | No external sends                                       | PASS (no WhatsApp calls, no outbound HTTP) |
| 14 | No production data modified                             | PASS (wa_admin row counts identical) |
| 15 | Test baseline documented                                | PASS (this file) |

---

## 9. Handoff to WA-ERA5-01

`WA-ERA5-01` (initial administrator bootstrap, first tenant
onboarding, real application navigation) can proceed against this
baseline. The isolated environment is:

- Reachable at `http://localhost:4030` (use `bash scripts/era5-start.sh`).
- Backed by `whatsapp_era5_test` (PostgreSQL, port 5434, user `wa`).
- BullMQ-isolated under prefix `wa-queue-era5`.
- Smoke harness reusable via `npx tsx scripts/era5-browser-smoke.ts`.

No pre-existing database, Redis key, or production data was modified.
