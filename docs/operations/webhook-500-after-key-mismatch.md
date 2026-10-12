# Operational note: /api/webhook 500 → 403/200 after bounded fix

## Status

- **Code fix applied** (commit pending): `getWabaConfig` and `getTenantWabaConfig`
  in `src/lib/settings.ts` now isolate `decrypt()` failures and degrade
  `accessToken` to `null` with a warning log. The webhook verification
  handshake and POST endpoint no longer return 500 when the encrypted
  access-token blob is unreadable.
- **Operator action still required**: the underlying state is
  `wabaSettings.accessTokenEnc` (or `wabaAccount.accessTokenEnc`) was
  encrypted under a different `ENCRYPTION_KEY` than the one currently
  loaded by the running process. The GCM auth-tag check correctly fails.
  The endpoint now responds correctly, but the access token itself is
  unusable until the blob is re-encrypted or the token is rotated.

## What the operator should do

1. **Identify the cause** — search the server log for:
   ```
   [settings] access token decrypt failed (ENCRYPTION_KEY mismatch or corrupted blob); returning null. Original error: Unsupported state or unable to authenticate data
   ```
   If present, the token in the DB is unreadable with the current
   `ENCRYPTION_KEY`.

2. **Decide which side is canonical**:
   - If the `ENCRYPTION_KEY` currently in `.env` is the one you intend to
     keep (new environment, freshly rotated key): rotate the access token
     via `PUT /api/tenants/<tenantId>/settings` or
     `PUT /api/settings` and supply a new plaintext token. The handler
     will re-encrypt under the current key.
   - If the encrypted blob is the canonical one (production DB restored
     to a dev environment, or vice versa): restore the `ENCRYPTION_KEY`
     that was used to encrypt the blob. The token is in
     `wabaSettings.accessTokenEnc` (singleton) or
     `wabaAccount.accessTokenEnc` (per-tenant).

3. **Verify** — after the fix, `GET /api/webhook?hub.mode=subscribe&hub.verify_token=<correct>&hub.challenge=x`
   should return `200 x` if the token matches, or `403 Forbidden` if not.
   A 500 means the row itself is unreadable (database connectivity
   issue, not crypto).

4. **Audit any other places that may share the same blob** — if the
   decrypt failure was logged for the singleton `wabaSettings` row, the
   same is true for every consumer of that token. If it was logged for a
   `wabaAccount` row, only that tenant is affected.

## What the code fix does NOT do

- It does not change `decrypt()` semantics. The crypto layer still
  fails closed on auth-tag mismatch — that is correct behaviour for
  AES-256-GCM and must not be relaxed.
- It does not re-encrypt the stored blob. Re-encryption is a write
  operation that needs a plaintext token; the operator must supply it.
- It does not bypass the access token. Calls that depend on the token
  (e.g. sending a template) will still fail with their own error. The
  fix is scoped to letting non-token consumers (the webhook handshake,
  the settings GET) continue to function.

## Why this is a bounded fix, not an architectural change

- It does not modify the schema.
- It does not introduce a new token format.
- It does not change the webhook contract.
- It does not touch ERAs 1/2/3 (FROZEN).
- It preserves the existing fail-closed semantics of `decrypt()`.
- It is exercised by 4 new unit tests
  (`test/lib/settings-decrypt-isolation.test.ts`) that pin both the
  failure and success paths.
