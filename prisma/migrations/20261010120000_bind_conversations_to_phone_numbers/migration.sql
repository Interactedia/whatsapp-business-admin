-- AlterTable
ALTER TABLE "WabaAccount" ADD COLUMN "metaAppId" TEXT;
ALTER TABLE "WabaAccount" ADD COLUMN "accessTokenEnc" TEXT;
ALTER TABLE "WabaAccount" ADD COLUMN "appSecret" TEXT;
ALTER TABLE "WabaAccount" ADD COLUMN "apiVersion" TEXT NOT NULL DEFAULT 'v21.0';

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "phoneNumberId" TEXT;

-- CreateIndex
CREATE INDEX "Conversation_phoneNumberId_idx" ON "Conversation"("phoneNumberId");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_phoneNumberId_fkey" FOREIGN KEY ("phoneNumberId") REFERENCES "PhoneNumber"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
