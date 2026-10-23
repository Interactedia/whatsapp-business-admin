-- WA-OUTRETRY-01: outbound auto-retry bookkeeping columns.
-- Forward-only: no destructive operations. Existing rows get the
-- declared defaults (0 / NULL).

-- AlterTable
ALTER TABLE "OutboundSendAttempt"
  ADD COLUMN IF NOT EXISTS "autoRetryCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "nextEligibleRetryAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastRetryAfterSec" INTEGER;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OutboundSendAttempt_state_nextEligibleRetryAt_idx"
  ON "OutboundSendAttempt" ("state", "nextEligibleRetryAt");
