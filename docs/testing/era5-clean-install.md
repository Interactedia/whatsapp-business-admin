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

---

# Appendix: WA-ERA5-01 — First Login, Tenant Bootstrap and Real Browser Security Validation

WA-ERA5-01 builds on the clean baseline above. It exercises the real
Chromium browser against the running app, validates the existing
authentication, authorization and tenant membership stack, and
verifies cross-tenant isolation in both the UI and the API.

## A1. Bootstrap procedure used

The application ships with a single supported bootstrap path
(`prisma/seed.ts`). ERA 5 ran the seed against the isolated test
database using the existing opt-in guard.

```bash
set -a && . ./.env.era5 && set +a
export WBA_ALLOW_DEMO_SEED=true
# SEED_ADMIN_PASSWORD is read from the local shell; never store it on disk
# in the repository. The same value is reused as SEED_PASSWORD when
# driving scripts/era5-browser-smoke.ts.
export SEED_ADMIN_PASSWORD="$ERA5_SEED_PASSWORD"
npx tsx prisma/seed.ts
```

`SEED_ADMIN_PASSWORD` is supplied only via the shell environment, never
committed to disk or logs. `WBA_ALLOW_DEMO_SEED=true` is the existing
safety guard and only flips the seed into local-fixture mode; it does
not weaken production data because the seed refuses to run against a
database other than the configured `DATABASE_URL`.

After running the seed, `whatsapp_era5_test` contains:

| Table             | Rows | Notes                                          |
| ----------------- | ---: | ---------------------------------------------- |
| Tenant            |    2 | Default Organization, Acme Corp                |
| User              |    6 | system admin, 2 tenant admins, 2 tenant agents, 1 no-membership |
| TenantMembership  |    4 | 2 admins + 2 agents, each bound to one tenant  |
| WabaSettings      |    1 | singleton                                       |

`wa_admin` was untouched. Re-verified post-run: 6 users, identical
to the WA-ERA5-00 baseline.

## A2. Test identities

| Email                     | Role          | Tenant            |
| ------------------------- | ------------- | ----------------- |
| admin@superadmin.com      | SYSTEM_ADMIN  | none (platform)   |
| admin@default.com         | ADMIN         | Default Org       |
| admin@acme.com            | ADMIN         | Acme Corp         |
| agent@default.com         | AGENT         | Default Org       |
| agent@acme.com            | AGENT         | Acme Corp         |
| agent@nomember.com        | AGENT         | none (no tenant)  |

The shared password is generated per environment, held only in the
local shell, and never written to any committed file. It is only
valid inside the `whatsapp_era5_test` database on the local
workstation. To reproduce, set `SEED_PASSWORD` in your shell before
invoking the browser smoke (`scripts/era5-browser-smoke.ts`).

## A3. Browser scenarios executed

Driven by `scripts/era5-browser-smoke.ts` using Playwright
`@playwright/test` Chromium. Output in `/tmp/era5-smoke/`.

The script runs 5 isolated browser contexts (one per persona) and
collects a JSON `observations.json` plus 10 screenshots. 32 findings
were produced; all 32 PASS.

Screenshots captured:

| File                                | What it shows                                          |
| ----------------------------------- | ------------------------------------------------------ |
| 01-root-redirect.png                | Anonymous user hitting `/` → redirect to `/login`     |
| 02-login-page.png                   | Login form rendered with email, password, submit       |
| 03-invalid-creds.png                | Bad credentials, error message visible                 |
| 04-admin-after-login.png            | SYSTEM_ADMIN landed on `/admin` after signIn           |
| 05-admin-dashboard.png              | `/admin` rendered with Tenant / User / Memberships KPIs |
| 06-admin-tenants.png                | `/admin/tenants` page reachable                        |
| 07-session-reload.png               | Page reload preserves the SYSTEM_ADMIN session         |
| 08-after-logout.png                 | Post-logout `/admin` redirects to `/login`             |
| 09-tenant-a-cross-tenant.png        | Tenant A user blocked from Tenant B resource           |
| 10-non-member-admin.png             | Authenticated non-member blocked from `/admin`         |

## A4. Successful operations

- Anon root → `/login?callbackUrl=…` (307).
- Anon API `/api/tenants/.../contacts` → 401 JSON.
- Invalid credentials → error visible, no session.
- SYSTEM_ADMIN login → `/admin` 200, KPIs rendered.
- Session persists across page reload.
- `/api/auth/session` returns the SYSTEM_ADMIN user record.
- SYSTEM_ADMIN does **not** bypass membership on tenant APIs
  (`/api/tenants/<id>/contacts` → 403 "Tenant access denied").
- Logout → 302 from `/api/auth/signout`, `/admin` then redirects to
  `/login?callbackUrl=/admin`.
- Tenant A admin authorized for `/api/tenants/<A>/contacts` (200).
- Tenant A admin denied for `/api/tenants/<B>/contacts` (403).
- Caller-controlled `_for_tenant` query parameter is ignored: the
  authorization layer still resolves the membership for the path
  tenant, not the query string.
- Tenant B admin authorized for `/api/tenants/<B>/contacts` (200).
- Tenant B admin denied for `/api/tenants/<A>/contacts` (401).
- Authenticated non-member denied for both tenants (401).

## A5. Confirmed defect corrected

**Defect: LoginPage submitted the credentials form, the server
authenticated successfully (set `authjs.session-token`, returned
`{"url": callbackUrl}`), but the client-side handler treated the
missing `res.error` as proof of success without verifying the
session, then called `router.push(callbackUrl || "/")` while the
user was still sitting on `/login`. The user appeared not to be
logged in even though the cookie was set.**

Reproduction (pre-fix, captured by the browser smoke harness):
1. Submit valid credentials on `/login`.
2. `signIn` returns `{url: "/login"}` with no `error` field.
3. `router.push("/login")` keeps the URL unchanged.
4. `/api/auth/session` returns the authenticated user; the cookie
   is in the jar; navigating manually to `/admin` works.

This is a real defect because operators have no visual feedback
that authentication succeeded and have to manually reload to enter
the app. It is not a security defect — the session cookie is set
correctly and the server enforces auth properly — but it is a
correctness defect for a login screen.

### Root cause

Auth.js v5 (beta 32) `next-auth/react` `signIn({ redirect: false })`
returns the `callbackUrl` in the JSON response even on success and
does not include an `error` field. The LoginPage relied on a
missing `res.error` as proof of success and never verified the
session. The two facts are not equivalent.

### Fix

`src/app/login/page.tsx`: after the `signIn` call, fetch
`/api/auth/session` and require `session.user.email` to be present
before navigating. On miss, surface the same "credentials incorrect"
error as the original failure path. Broadcast the session change so
any open tab can refetch.

### Regression coverage

`test/login-page-session-verify.test.ts` covers three cases:

1. Session with `user.email` → authenticated.
2. Session with `null` user → treated as failure.
3. Network failure (500) → treated as failure.

The 32-finding browser smoke also re-verifies that, after the fix,
the four persona logins land on the correct protected route
(`/admin`, `/admin/tenants`, `/admin/users`, `/t/<tenantId>/inbox`).

## A6. Known limitations / remaining gaps

- **API-key driven admin flows.** The smoke test uses browser
  cookies. v1 REST API flows via `ApiKey` are out of scope for
  WA-ERA5-01 and were not exercised here. Cross-tenant
  `ApiKey.tenantId` enforcement has its own unit coverage
  (`test/api-key-tenancy.test.ts`).
- **2FA / passkey / webauthn.** Not in scope; the login form is
  email + password only.
- **Real WhatsApp sending.** Not exercised; `BULLMQ_PREFIX=
  wa-queue-era5` and the absence of WABA credentials in the test
  env make any outbound send impossible by construction.
- **Cross-tenant UI screenshots.** Tenant A admin attempting
  `/t/acme/inbox` is redirected to `/login` (session active) but
  the redirected page is the same login form; the smoke verifies
  the API boundary (403) and the URL change, not a custom 403
  page (none exists in the codebase).
- **No load / no chaos.** Out of scope; only one user at a time
  per persona, no parallel sessions, no token expiry tests.

## A7. Guardrails for WA-ERA5-01

| Gate                                | Command                                          | Result            |
| ----------------------------------- | ------------------------------------------------ | ----------------- |
| Prisma schema validation            | `npx prisma validate`                            | PASS              |
| `wa_admin` preservation             | psql row counts before/after                     | PASS (6 users unchanged) |
| Test DB identity                    | `current_database()`                             | PASS (`whatsapp_era5_test`) |
| Seed bootstrap                      | `npx tsx prisma/seed.ts` (with WBA opt-in)       | PASS (6 users, 2 tenants, 4 memberships) |
| Real browser smoke                  | `npx tsx scripts/era5-browser-smoke.ts`          | 32/32 PASS        |
| TypeScript typecheck                | `npx tsc --noEmit`                               | PASS              |
| Lint                                | `npm run lint`                                   | PASS (no warnings) |
| Full vitest suite                   | `npx vitest run`                                 | 82 files, 961 tests PASS |
| Build                               | `npm run build`                                  | PASS              |
| Git diff sanity                     | `git diff --check`                               | PASS              |

## A8. Files added or changed by WA-ERA5-01

- `prisma/seed.ts` — extended with Tenant A agent, Tenant B agent,
  and a no-membership agent; seed reuses existing opt-in guard.
- `scripts/era5-browser-smoke.ts` — extended to 5 personas, 32
  findings, 10 screenshots, JSON observations file.
- `src/app/login/page.tsx` — fixed the client-side success-detection
  defect described in A5.
- `test/login-page-session-verify.test.ts` — new regression test
  for the LoginPage fix.
- `docs/testing/era5-clean-install.md` — this appendix.
