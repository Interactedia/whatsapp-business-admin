-- Additive transactional outbox foundation for durable PostgreSQL -> BullMQ handoff.
CREATE TYPE "OutboxPublicationState" AS ENUM ('PENDING', 'CLAIMED', 'PUBLISHED', 'RETRYABLE', 'TERMINAL');

CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "contractVersion" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "state" "OutboxPublicationState" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedBy" TEXT,
    "claimExpiresAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "lastAttemptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OutboxEvent_state_nextAttemptAt_createdAt_idx" ON "OutboxEvent"("state", "nextAttemptAt", "createdAt");
CREATE INDEX "OutboxEvent_state_claimExpiresAt_idx" ON "OutboxEvent"("state", "claimExpiresAt");
CREATE INDEX "OutboxEvent_tenantId_createdAt_idx" ON "OutboxEvent"("tenantId", "createdAt");
CREATE INDEX "OutboxEvent_publishedAt_idx" ON "OutboxEvent"("publishedAt");

ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
