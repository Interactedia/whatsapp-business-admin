-- Add durable marker for the Meta send boundary.
-- Additive: nullable column only; preserves existing OutboundSendAttempt rows.

ALTER TABLE "OutboundSendAttempt"
  ADD COLUMN IF NOT EXISTS "metaRequestStartedAt" TIMESTAMP(3);
