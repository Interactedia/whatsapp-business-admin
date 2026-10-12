-- WA-ERA3-05 durable canonical event delivery state.
-- Additive only: CanonicalEventOutbox rows remain immutable and are not backfilled or deleted.

CREATE TYPE "CanonicalEventDeliveryState" AS ENUM (
  'PENDING',
  'IN_PROGRESS',
  'RETRY_PENDING',
  'ACCEPTED',
  'FAILED_TERMINAL'
);

CREATE TYPE "CanonicalEventDeliveryAttemptResult" AS ENUM (
  'ACCEPTED',
  'RETRYABLE',
  'TERMINAL',
  'INTERRUPTED'
);

CREATE TABLE "CanonicalEventDelivery" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "destinationId" TEXT NOT NULL,
  "state" "CanonicalEventDeliveryState" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastError" TEXT,
  "acceptedAt" TIMESTAMP(3),
  "terminalAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CanonicalEventDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CanonicalEventDelivery_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CanonicalEventDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "CanonicalEventOutbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "CanonicalEventDeliveryAttempt" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "deliveryId" TEXT NOT NULL,
  "leaseOwner" TEXT NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "httpStatus" INTEGER,
  "result" "CanonicalEventDeliveryAttemptResult" NOT NULL DEFAULT 'INTERRUPTED',
  "errorSummary" TEXT,
  "nextRetryAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CanonicalEventDeliveryAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CanonicalEventDeliveryAttempt_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "CanonicalEventDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CanonicalEventDelivery_tenantId_eventId_destinationId_key" ON "CanonicalEventDelivery"("tenantId", "eventId", "destinationId");
CREATE INDEX "CanonicalEventDelivery_state_nextAttemptAt_createdAt_idx" ON "CanonicalEventDelivery"("state", "nextAttemptAt", "createdAt");
CREATE INDEX "CanonicalEventDelivery_state_leaseExpiresAt_idx" ON "CanonicalEventDelivery"("state", "leaseExpiresAt");
CREATE INDEX "CanonicalEventDelivery_tenantId_state_nextAttemptAt_idx" ON "CanonicalEventDelivery"("tenantId", "state", "nextAttemptAt");
CREATE UNIQUE INDEX "CanonicalEventDeliveryAttempt_deliveryId_attemptNumber_key" ON "CanonicalEventDeliveryAttempt"("deliveryId", "attemptNumber");
CREATE INDEX "CanonicalEventDeliveryAttempt_deliveryId_startedAt_idx" ON "CanonicalEventDeliveryAttempt"("deliveryId", "startedAt");
CREATE INDEX "CanonicalEventDeliveryAttempt_result_createdAt_idx" ON "CanonicalEventDeliveryAttempt"("result", "createdAt");
