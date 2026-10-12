-- WA-ERA3-07 security remediation — additive, non-destructive.
--
-- 1. Adds the SUSPENDED state to the canonical event delivery state machine so
--    deliveries affected by a webhook endpoint change become non-dispatchable.
-- 2. Records the endpoint URL that was replaced when deliveries were suspended,
--    so an administrative resume can require explicit recipient confirmation.
--
-- Existing rows, history and the canonical event outbox are untouched.

ALTER TYPE "CanonicalEventDeliveryState" ADD VALUE 'SUSPENDED';

ALTER TABLE "WebhookDestination" ADD COLUMN "deliverySuspensionUrl" TEXT;
