-- Add durable outbound execution ownership.
-- Additive: new enum variant + new table + new Message/Tenant relations.
-- Non-destructive: does not modify any existing data.

-- 1. Extend Role enum with SYSTEM_ADMIN (the drift detected by Prisma)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'Role' AND e.enumlabel = 'SYSTEM_ADMIN'
  ) THEN
    ALTER TYPE "Role" ADD VALUE 'SYSTEM_ADMIN';
  END IF;
END $$;

-- 2. New enum: OutboundAttemptState
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OutboundAttemptState') THEN
    CREATE TYPE "OutboundAttemptState" AS ENUM (
      'PENDING',
      'CLAIMED',
      'SENT',
      'FAILED',
      'RETRYABLE',
      'UNCERTAIN'
    );
  END IF;
END $$;

-- 3. New table: OutboundSendAttempt
CREATE TABLE IF NOT EXISTS "OutboundSendAttempt" (
  "id" TEXT PRIMARY KEY,
  "messageId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "state" "OutboundAttemptState" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "ownerId" TEXT,
  "claimExpiresAt" TIMESTAMP(3),
  "metaRequestStartedAt" TIMESTAMP(3),
  "waMessageId" TEXT,
  "lastErrorCode" TEXT,
  "lastErrorMessage" TEXT,
  "lastMetaStatus" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "OutboundSendAttempt_messageId_fkey" FOREIGN KEY ("messageId")
    REFERENCES "Message"("id") ON DELETE CASCADE,
  CONSTRAINT "OutboundSendAttempt_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON DELETE RESTRICT
);

ALTER TABLE "OutboundSendAttempt"
  ADD COLUMN IF NOT EXISTS "metaRequestStartedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "OutboundSendAttempt_messageId_state_idx"
  ON "OutboundSendAttempt"("messageId", "state");
CREATE INDEX IF NOT EXISTS "OutboundSendAttempt_state_claimExpiresAt_idx"
  ON "OutboundSendAttempt"("state", "claimExpiresAt");
CREATE INDEX IF NOT EXISTS "OutboundSendAttempt_tenantId_state_idx"
  ON "OutboundSendAttempt"("tenantId", "state");
