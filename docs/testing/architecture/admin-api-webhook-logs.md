# System Administration — API and Webhook Logs

**Task:** WA-ADMIN-LOGS-API-WEBHOOKS
**Status:** Implemented

## Overview

Provides SYSTEM_ADMIN users with operational visibility into outbound WhatsApp Graph API calls and inbound webhook events, reusing existing persistence infrastructure without introducing new logging platforms.

## Sources

### API Logs (`ApiLog`)

Outbound HTTP calls made by the platform to the Meta WhatsApp Graph API are recorded in `ApiLog` (Prisma schema). Persistence happens in:

- `src/lib/whatsapp/client.ts` — `callGraph` function (messages, templates, media downloads)
- `src/lib/whatsapp/template-history.ts` — template audit queries
- `src/lib/whatsapp/upload.ts` — media uploads
- `src/lib/whatsapp/media.ts` — media fetch/upload

**Stored fields:** `method`, `endpoint`, `requestBody` (sanitized), `responseStatus`, `responseBody`, `ok`, `durationMs`, `relatedType`, `relatedId`, `createdAt`.

**Sanitization:** `sanitizeBody` in `client.ts` redacts `flow_token` and `flow_action_payload` before storage. Bearer tokens, API keys, cookies, and authorization headers are never stored.

**Missing:** No tenant ownership on ApiLog — therefore tenant-scoped API log access is not implemented. Tenant ADMIN/AGENT cannot access API logs.

### Webhook Logs (`WebhookEvent`)

Every inbound webhook POST from Meta is recorded in `WebhookEvent` (Prisma schema):

- `src/app/api/webhook/route.ts` — stores raw payload immediately, then updates `processedOk` after async/sync processing
- `src/lib/whatsapp/inbound/receipt.ts` — async inbound path via Outbox
- `src/lib/whatsapp/status/receipt.ts` — async status path via Outbox

**Stored fields:** `payload` (redacted via `redactFlowWebhookPayload`), `signatureValid`, `processedOk`, `eventSummary`, `error`, `createdAt`.

**Note:** `WebhookEvent` has no tenant ownership. Global SYSTEM_ADMIN access is provided. Individual webhook records implicitly carry tenant context through the payload metadata (phone_number_id → tenant), but this is not filtered by the logs API — it is a global feed.

## Available Filters

### API Logs (`?type=api`)

| Parameter | Description |
|-----------|-------------|
| `?method=GET\|POST\|DELETE\|PATCH` | HTTP method (uppercase match) |
| `?endpoint=/v18.0/...` | Partial endpoint match (case-insensitive) |
| `?ok=true\|false` | Success / failure |
| `?related=template\|message\|broadcast\|media-upload` | Related entity type |
| `?from=ISO` | Created after |
| `?to=ISO` | Created before |
| `?page=N` | Page number (1-indexed) |
| `?pageSize=N` | Page size (max 200, default 50) |

### Webhook Logs (`?type=webhook`)

| Parameter | Description |
|-----------|-------------|
| `?sig=valid\|invalid` | Signature verification result |
| `?processed=ok\|error` | Processing outcome |
| `?from=ISO` | Created after |
| `?to=ISO` | Created before |
| `?page=N` | Page number (1-indexed) |
| `?pageSize=N` | Page size (max 200, default 50) |

## Webhook Lifecycle States

The `processedOk` field distinguishes stages, but does not imply atomic guarantees:

| `processedOk` | `signatureValid` | Meaning |
|--------------|-----------------|---------|
| `true` | `true` / `false` | HTTP 200 sent to Meta; async worker completed successfully |
| `false` | `true` | HTTP 200 sent; async worker accepted but failed |
| `false` | `false` | HTTP 200 sent (to prevent Meta retry); signature invalid, not processed |

**Invariant 7:** HTTP 200 does not imply worker completion. `processedOk=false` with no error means the webhook was accepted but the async worker has not yet reported.

## Authorization Boundaries

| Role | Global Logs | Notes |
|------|-----------|-------|
| SYSTEM_ADMIN | Read | Full access to both API and webhook logs |
| ADMIN | Denied (403) | No tenant ownership on legacy logs |
| AGENT | Denied (403) | No tenant ownership on legacy logs |

Authorization is enforced server-side in `src/app/api/logs/route.ts` and in the page component `src/app/(app)/logs/page.tsx`. Menu visibility alone is not relied upon.

## Privacy / Redaction Rules

1. Bearer tokens, API keys, cookies, and authorization headers are never stored (not in `requestBody` or `responseBody`).
2. `flow_token` and `flow_action_payload` fields are redacted in `ApiLog.requestBody` by `sanitizeBody`.
3. Raw WhatsApp message contents in webhook payloads are not exposed in the UI table — only `eventSummary` (a human label) and `error` are shown.
4. The detail dialog (removed from this implementation) would expose `requestBody`/`responseBody` for SYSTEM_ADMIN debugging — acceptable since SYSTEM_ADMIN is a platform operator, not a tenant user.
5. `WebhookEvent.payload` is pre-redacted via `redactFlowWebhookPayload` before storage.

## Retention Behavior

Existing retention policy applies. `ApiLog` and `WebhookEvent` have no explicit TTL — retention follows the platform's database retention configuration. No new retention policy was introduced.

## API Endpoint

`GET /api/logs?type=api|webhook&...`

Requires session cookie. Returns:

```json
{
  "type": "api",
  "items": [...],
  "total": 123,
  "page": 1,
  "pageSize": 50
}
```

## Known Limitations

- `ApiLog` and `WebhookEvent` have no tenant ownership — tenant-scoped log queries are not supported.
- Tenant ADMIN cannot access global logs (by design; no tenant isolation gap because there are no tenant-scoped logs).
- `processedOk=false` with no `error` may indicate an in-flight async worker — not a definite failure.
- No correlation ID between ApiLog and WebhookEvent records.
- Date range filters apply to `createdAt`, which is the storage time, not the Meta event timestamp.

## Test Commands

```bash
npm run test -- --run test/logs-authorization.test.ts
npm run lint
npx tsc --noEmit
npm run build
npx prisma validate
```

## Files Changed

- `src/components/shell/nav.ts` — added `/logs` nav item
- `src/app/api/logs/route.ts` — added filters, bounded pagination
- `src/app/(app)/logs/logs-client.tsx` — added filter UI, sanitized types
- `src/app/(app)/logs/page.tsx` — updated comments
- `test/logs-authorization.test.ts` — extended authorization and filter coverage
- `docs/architecture/admin-api-webhook-logs.md` — this file
