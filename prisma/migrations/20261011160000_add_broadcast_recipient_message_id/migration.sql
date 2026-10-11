-- AlterTable: Add nullable messageId to BroadcastRecipient for durable execution ownership link
ALTER TABLE "BroadcastRecipient" ADD COLUMN IF NOT EXISTS "messageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "BroadcastRecipient_messageId_key" ON "BroadcastRecipient"("messageId");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BroadcastRecipient_messageId_fkey'
  ) THEN
    ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT "BroadcastRecipient_messageId_fkey"
      FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
