-- Add tenant-scoped outbound webhook destination registry.
CREATE TABLE "WebhookDestination" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "endpointUrl" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "retiredAt" TIMESTAMP(3),
  "subscriptions" TEXT[],
  "signingSecretEnc" TEXT NOT NULL,
  "secretVersion" INTEGER NOT NULL DEFAULT 1,
  "lastTestAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WebhookDestination_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WebhookDestination_tenantId_enabled_idx" ON "WebhookDestination"("tenantId", "enabled");
CREATE INDEX "WebhookDestination_tenantId_retiredAt_idx" ON "WebhookDestination"("tenantId", "retiredAt");

ALTER TABLE "WebhookDestination"
  ADD CONSTRAINT "WebhookDestination_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
