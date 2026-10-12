-- Additive: external client idempotency for POST /api/v1/messages.
-- Both columns are nullable, so existing (unkeyed) rows and requests are unaffected.
-- The unique index is tenant-scoped: PostgreSQL treats NULL keys as distinct,
-- so a key can never deduplicate across tenants and unkeyed rows never collide.
ALTER TABLE "Message" ADD COLUMN     "idempotencyFingerprint" TEXT,
ADD COLUMN     "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "Message_tenantId_idempotencyKey_key" ON "Message"("tenantId", "idempotencyKey");
