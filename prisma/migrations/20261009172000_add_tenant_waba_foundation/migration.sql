-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WabaAccount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "metaWabaId" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WabaAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhoneNumber" (
    "id" TEXT NOT NULL,
    "wabaAccountId" TEXT NOT NULL,
    "metaPhoneNumberId" TEXT NOT NULL,
    "displayPhone" TEXT,
    "verifiedName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhoneNumber_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WabaAccount_tenantId_idx" ON "WabaAccount"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "WabaAccount_tenantId_metaWabaId_key" ON "WabaAccount"("tenantId", "metaWabaId");

-- CreateIndex
CREATE INDEX "PhoneNumber_wabaAccountId_idx" ON "PhoneNumber"("wabaAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneNumber_wabaAccountId_metaPhoneNumberId_key" ON "PhoneNumber"("wabaAccountId", "metaPhoneNumberId");

-- AddForeignKey
ALTER TABLE "WabaAccount" ADD CONSTRAINT "WabaAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneNumber" ADD CONSTRAINT "PhoneNumber_wabaAccountId_fkey" FOREIGN KEY ("wabaAccountId") REFERENCES "WabaAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;