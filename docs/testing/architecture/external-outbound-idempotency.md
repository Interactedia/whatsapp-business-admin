# External Outbound Idempotency — POST /api/v1/messages

**Status:** implemented (WA-REMEDIATION-1A)
**Scope:** WhatsApp Backoffice external v1 message API. OSA adapter and delivery-status lookup are out of scope.

## Why

External callers must be able to retry `POST /api/v1/messages` after an HTTP timeout
without risking a duplicate WhatsApp delivery. The BullMQ job identity protects the
outbound worker, but it is not a substitute for a caller-supplied idempotency key: it
does not survive the HTTP boundary. This adds durable, tenant-scoped external idempotency.

## Header

```
Idempotency-Key: <string>      (optional)
```

- 1–200 characters; ASCII letters, digits, `.`, `-`, `_`, `:` only.
- Absent header → the request behaves exactly as before (no deduplication).
- Malformed header (empty, too long, disallowed characters) → `400`.

## Canonical request equivalence

Two requests are equivalent for the same tenant when their material fields match:

- channel / account (`phoneNumberId`),
- recipient (`to`),
- conversation,
- message type,
- content (text, media, template name/language/parameters, header, buttons, Flow data).

The fingerprint is a SHA-256 over the canonicalized fields. Transport/auth metadata
(`apikey`) and server-generated values (Flow tokens) are excluded, so a replay across
processes or restarts produces the same fingerprint.

## Response semantics

| Case | HTTP | Body |
| --- | --- | --- |
| First accepted request (sync) | `201` | `{ status, message_id, id, to }` — unchanged legacy shape |
| First accepted request (async) | `202` | `{ status, id, status, to, accepted: true }` — unchanged legacy shape |
| Equivalent duplicate | `200` | `{ status, id, to, duplicate: true, message_status, message_id? }` |
| Conflicting duplicate (same key, different payload) | `409` | `{ status: "error", code: "IDEMPOTENCY_KEY_CONFLICT", message }` |
| Concurrent in-progress duplicate | `200` | resolved to the equivalent-duplicate form once the winning request commits |

`message_id` is present **only** when a Meta `wamid` was actually persisted. A duplicate
never fabricates an acknowledgement — it reports the stored `message_status`
(e.g. `PENDING`, `SENT`, `FAILED`).

## Isolation and durability

- Uniqueness is enforced by PostgreSQL: `Message @@unique([tenantId, idempotencyKey])`.
  A key cannot deduplicate across tenants, channels, recipients or conversations — those
  yield a different fingerprint and therefore a `409` conflict.
- The key is bound atomically with the message row. A concurrent duplicate loses the
  unique-constraint race and is resolved to the same duplicate response: it never enqueues
  a second job and never performs a second provider transmission.
- Authentication and tenant/recipient authorization are evaluated on every request,
  including duplicates. A duplicate never discloses another tenant's message.
- The binding lives in PostgreSQL and survives process restarts; the fingerprint is
  recomputed deterministically from the request.

## Examples

First request (sync, default):

```bash
curl -X POST https://<host>/api/v1/messages \
  -H "x-api-key: wba_live_..." \
  -H "Idempotency-Key: osa-run-42-msg-1" \
  -H "content-type: application/json" \
  -d '{"to":"919812345678","type":"text","text":"Hi"}'
# 201 { "status":"success", "message_id":"wamid....", "id":"msg_...", "to":"919812345678" }
```

Equivalent retry (same key, same payload):

```json
{ "status":"success", "id":"msg_...", "to":"919812345678",
  "duplicate":true, "message_status":"SENT", "message_id":"wamid...." }
```

Conflicting reuse (same key, different payload):

```json
{ "status":"error", "code":"IDEMPOTENCY_KEY_CONFLICT",
  "message":"Idempotency-Key was already used with a different request payload." }
```

## Migration

Additive migration `20261012150000_add_message_idempotency` adds two nullable `Message`
columns (`idempotencyKey`, `idempotencyFingerprint`) and the tenant-scoped unique index.
It is non-destructive; existing rows and requests without a key are unaffected.
