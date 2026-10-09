import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
const migration = readFileSync(
  join(process.cwd(), "prisma/migrations/20261009173500_add_nullable_tenant_ownership_to_messaging/migration.sql"),
  "utf8",
);

function modelBlock(name: string) {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`Missing model ${name}`);
  return match[1];
}

describe("WA-01-02 tenant ownership foundation for messaging data", () => {
  it("adds nullable tenant ownership to Contact", () => {
    const tenant = modelBlock("Tenant");
    const contact = modelBlock("Contact");

    expect(tenant).toContain('contacts     Contact[]      @relation("TenantContacts")');
    expect(contact).toContain("tenantId      String?");
    expect(contact).toContain(
      'tenant        Tenant?   @relation("TenantContacts", fields: [tenantId], references: [id], onDelete: Restrict)',
    );
    expect(contact).toContain("@@index([tenantId])");
  });

  it("adds nullable tenant ownership to Conversation", () => {
    const tenant = modelBlock("Tenant");
    const conversation = modelBlock("Conversation");

    expect(tenant).toContain('conversations Conversation[] @relation("TenantConversations")');
    expect(conversation).toContain("tenantId       String?");
    expect(conversation).toContain(
      'tenant         Tenant?            @relation("TenantConversations", fields: [tenantId], references: [id], onDelete: Restrict)',
    );
    expect(conversation).toContain("@@index([tenantId])");
  });

  it("adds nullable tenant ownership to Message", () => {
    const tenant = modelBlock("Tenant");
    const message = modelBlock("Message");

    expect(tenant).toContain('messages      Message[]      @relation("TenantMessages")');
    expect(message).toContain("tenantId       String?");
    expect(message).toContain(
      'tenant         Tenant?          @relation("TenantMessages", fields: [tenantId], references: [id], onDelete: Restrict)',
    );
    expect(message).toContain("@@index([tenantId])");
  });

  it("keeps existing uniqueness semantics unchanged", () => {
    expect(modelBlock("Contact")).toContain("waId          String    @unique");
    expect(modelBlock("Conversation")).toContain("contactId      String             @unique");
    expect(modelBlock("Message")).toContain("waMessageId    String?          @unique");

    expect(modelBlock("Contact")).not.toContain("@@unique([tenantId");
    expect(modelBlock("Conversation")).not.toContain("@@unique([tenantId");
    expect(modelBlock("Message")).not.toContain("@@unique([tenantId");
  });

  it("uses a strictly additive migration with nullable columns and foreign keys", () => {
    expect(migration).toContain('ALTER TABLE "Contact" ADD COLUMN "tenantId" TEXT;');
    expect(migration).toContain('ALTER TABLE "Conversation" ADD COLUMN "tenantId" TEXT;');
    expect(migration).toContain('ALTER TABLE "Message" ADD COLUMN "tenantId" TEXT;');
    expect(migration).toContain('CREATE INDEX "Contact_tenantId_idx" ON "Contact"("tenantId");');
    expect(migration).toContain('CREATE INDEX "Conversation_tenantId_idx" ON "Conversation"("tenantId");');
    expect(migration).toContain('CREATE INDEX "Message_tenantId_idx" ON "Message"("tenantId");');
    expect(migration).toContain('ALTER TABLE "Contact" ADD CONSTRAINT "Contact_tenantId_fkey"');
    expect(migration).toContain('ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_tenantId_fkey"');
    expect(migration).toContain('ALTER TABLE "Message" ADD CONSTRAINT "Message_tenantId_fkey"');
    expect(migration).toContain('REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE');

    expect(migration).not.toMatch(/\bDROP\b/i);
    expect(migration).not.toMatch(/^\s*(DELETE|UPDATE|TRUNCATE)\b/im);
    expect(migration).not.toMatch(/\bSET DEFAULT\b/i);
    expect(migration).not.toMatch(/\bNOT NULL\b/i);
    expect(migration).not.toContain("CREATE UNIQUE INDEX");
  });
});
