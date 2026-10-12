-- WA-ERA3-03: durable canonical external event outbox.
-- Additive only; ERA 2 OutboxEvent remains unchanged.

CREATE TABLE "CanonicalEventOutbox" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "contractVersion" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CanonicalEventOutbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CanonicalEventOutbox_tenantId_createdAt_idx" ON "CanonicalEventOutbox"("tenantId", "createdAt");
CREATE INDEX "CanonicalEventOutbox_tenantId_eventType_createdAt_idx" ON "CanonicalEventOutbox"("tenantId", "eventType", "createdAt");

ALTER TABLE "CanonicalEventOutbox" ADD CONSTRAINT "CanonicalEventOutbox_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
