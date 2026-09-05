# WhatsApp Business Admin

A self-hosted admin for the **Meta WhatsApp Business Cloud API**. Create and manage
message **templates** with a friendly wizard and live preview, run a two-way **inbox**,
send **broadcasts**, receive **webhooks**, manage **contacts**, and keep a complete
audit **log** of every API request/response and inbound webhook.

Built with **Next.js (App Router) + TypeScript**, **PostgreSQL + Prisma**, a custom Node
server hosting a **WebSocket** feed for realtime inbox updates, Tailwind + shadcn-style UI.

## Features

- **Templates** — 6-step wizard (category → header → body → footer → buttons → review) with
  a live WhatsApp-style preview, validation that mirrors Meta's rules, submit-for-approval,
  status sync, media-header sample upload, and delete.
- **Inbox** — conversation list, two-way chat, media (images/video/audio/documents),
  delivery ticks, and enforced **24-hour session window** (free-form inside, template-only
  outside). Live updates over WebSocket.
- **Broadcasts** — send an approved template to all contacts or a tag; in-process rate-limited
  queue; per-recipient delivery status from webhooks.
- **WhatsApp Flows** — visual + JSON multi-screen form builder, Meta validation/publishing,
  immutable version cloning, encrypted dynamic data endpoints, inbox/template/API launches,
  searchable submissions, retention controls, and signed completion webhooks.
- **Contacts** — auto-created on inbound, plus manual add; names, tags, notes.
- **Webhooks** — signature-verified (`X-Hub-Signature-256`); raw payload stored first, then
  processed (messages, statuses, template status updates).
- **Logs** — every outbound Graph API call and every inbound webhook, browsable in full.
- **Users & roles** — Admin (full) and Agent (inbox + contacts).

## Quick start (development)

Node.js 24 is required. If you use `nvm`, run `nvm use` from the project root.

```bash
# 1. Start Postgres (Docker). Exposed on host port 5434.
docker compose up -d db

# 2. Configure environment
cp .env.example .env
#   Generate secrets:
#     AUTH_SECRET     -> openssl rand -base64 32
#     ENCRYPTION_KEY  -> openssl rand -hex 32   (must be 64 hex chars)
#   Point DATABASE_URL at the db (default already uses localhost:5434).

# 3. Install deps, run migrations, seed an admin user
npm install
npm run db:generate
npm run db:migrate
npm run db:seed          # prints the seeded admin email/password

# 4. Run the app (custom Next.js server + WebSocket)
npm run dev
```

Open http://localhost:3000 and sign in with the seeded credentials
(`admin@example.com` / `admin1234` unless overridden). **Change the password after first login.**

## Connecting your WhatsApp account

In **Settings** (admin only), enter from Meta Business Manager → WhatsApp → API Setup:

- **WABA ID**, **Phone Number ID**, **Access Token** (stored AES-256-GCM encrypted)
- **Graph API version** (default `v21.0`)
- **Meta App ID** — only needed for image/video/document header templates
- **App Secret** — used to verify webhook signatures
- **Verify Token** — leave blank to auto-generate

Then in Meta → WhatsApp → Configuration, set the **Callback URL** shown in Settings
(`<APP_URL>/api/webhook`) and the **Verify Token**, and subscribe to the **messages** field.
Use an HTTPS tunnel such as `ngrok http 3000` in development so Meta can reach the webhook.

Click **Test connection** to validate the credentials.

## Production

```bash
# Full stack (app + Postgres) via Docker Compose
docker compose --profile full up -d --build
```

The app image runs `prisma migrate deploy` on start and launches the custom server under
`tsx` (Next + WebSocket on one port). Provide `.env` with production `AUTH_SECRET`,
`ENCRYPTION_KEY`, `APP_URL` (public HTTPS), and broker settings via the UI.

## Testing

```bash
npm test          # Vitest unit tests (validation, signatures, formatting, crypto, 24h window)
npx tsc --noEmit  # typecheck
```

## Architecture notes

- **`graphFetch()`** (`src/lib/whatsapp/client.ts`) is the single path for outbound Graph API
  calls; it auto-writes an `ApiLog` row for every request/response — logging can't be forgotten.
- **Realtime** uses a hub on `globalThis` (`src/server/realtime.ts`) so Next route handlers and
  the custom server share one WebSocket fan-out. The `/ws` upgrade is authenticated via the
  NextAuth session cookie.
- **Media** is stored behind a `MediaStore` interface (local filesystem by default; S3-swappable)
  and served through an authenticated route.
- **Flow responses** are encrypted at rest and removed on each Flow's retention schedule. Dynamic
  connector credentials and the Meta Flow private key are encrypted with `ENCRYPTION_KEY`.
- **Broadcasts** use an in-process `p-queue` (no Redis) sized for a single self-hosted instance.

See `docs/2026-07-24-whatsapp-business-admin-design.md` for the full design.
