-- WA-ERA5-03 diagnostic ownership, bounded payload retention and HTTP tracing.
-- Additive only: historical NULL tenant rows remain SYSTEM_ADMIN-only.

ALTER TABLE "ApiLog" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "ApiLog" ADD COLUMN "requestHeaders" JSONB;
ALTER TABLE "ApiLog" ADD COLUMN "responseHeaders" JSONB;
ALTER TABLE "ApiLog" ADD COLUMN "wabaId" TEXT;
ALTER TABLE "ApiLog" ADD COLUMN "phoneNumberId" TEXT;
ALTER TABLE "ApiLog" ADD COLUMN "attemptId" TEXT;
ALTER TABLE "ApiLog" ADD COLUMN "jobId" TEXT;
ALTER TABLE "ApiLog" ADD COLUMN "attemptNumber" INTEGER;
ALTER TABLE "ApiLog" ADD COLUMN "error" TEXT;
ALTER TABLE "ApiLog" ADD COLUMN "requestTruncated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ApiLog" ADD COLUMN "responseTruncated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ApiLog" ADD COLUMN "payloadExpiresAt" TIMESTAMP(3);

ALTER TABLE "WebhookEvent" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "WebhookEvent" ADD COLUMN "headers" JSONB;
ALTER TABLE "WebhookEvent" ADD COLUMN "wabaId" TEXT;
ALTER TABLE "WebhookEvent" ADD COLUMN "phoneNumberId" TEXT;
ALTER TABLE "WebhookEvent" ADD COLUMN "processingStage" TEXT;
ALTER TABLE "WebhookEvent" ADD COLUMN "payloadTruncated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "WebhookEvent" ADD COLUMN "payloadExpiresAt" TIMESTAMP(3);

ALTER TABLE "ApiLog" ADD CONSTRAINT "ApiLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "ApiLog_tenantId_createdAt_idx" ON "ApiLog"("tenantId", "createdAt");
CREATE INDEX "ApiLog_payloadExpiresAt_idx" ON "ApiLog"("payloadExpiresAt");
CREATE INDEX "WebhookEvent_tenantId_createdAt_idx" ON "WebhookEvent"("tenantId", "createdAt");
CREATE INDEX "WebhookEvent_payloadExpiresAt_idx" ON "WebhookEvent"("payloadExpiresAt");
