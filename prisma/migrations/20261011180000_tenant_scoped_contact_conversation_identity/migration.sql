-- Drop existing global unique indexes
DROP INDEX IF EXISTS "Contact_waId_key";
DROP INDEX IF EXISTS "Conversation_contactId_key";

-- Create tenant-scoped unique indexes
CREATE UNIQUE INDEX "Contact_tenantId_waId_key" ON "Contact"("tenantId", "waId");
CREATE UNIQUE INDEX "Conversation_tenantId_phoneNumberId_contactId_key" ON "Conversation"("tenantId", "phoneNumberId", "contactId");
CREATE INDEX "Conversation_contactId_idx" ON "Conversation"("contactId");
