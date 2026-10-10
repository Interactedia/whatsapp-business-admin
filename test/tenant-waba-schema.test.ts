import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
const migration = readFileSync(
  join(process.cwd(), "prisma/migrations/20261009172000_add_tenant_waba_foundation/migration.sql"),
  "utf8",
);
const bindingMigration = readFileSync(
  join(process.cwd(), "prisma/migrations/20261010120000_bind_conversations_to_phone_numbers/migration.sql"),
  "utf8",
);

function modelBlock(name: string) {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`Missing model ${name}`);
  return match[1];
}

describe("WA-01-01 tenant and WABA persistence foundation", () => {
  it("defines the Tenant, WabaAccount, and PhoneNumber models", () => {
    expect(schema).toContain("model Tenant {");
    expect(schema).toContain("model WabaAccount {");
    expect(schema).toContain("model PhoneNumber {");
  });

  it("defines the Tenant to WabaAccount relationship", () => {
    const tenant = modelBlock("Tenant");
    const waba = modelBlock("WabaAccount");

    expect(tenant).toMatch(/wabaAccounts\s+WabaAccount\[\]/);
    expect(waba).toContain("tenantId       String");
    expect(waba).toContain("tenant         Tenant   @relation(fields: [tenantId], references: [id], onDelete: Restrict)");
    expect(waba).toContain("@@unique([tenantId, metaWabaId])");
  });

  it("defines the WabaAccount to PhoneNumber relationship", () => {
    const waba = modelBlock("WabaAccount");
    const phone = modelBlock("PhoneNumber");

    expect(waba).toContain("phoneNumbers PhoneNumber[]");
    expect(waba).toContain("accessTokenEnc String?");
    expect(phone).toContain("wabaAccountId     String");
    expect(phone).toContain(
      "wabaAccount       WabaAccount @relation(fields: [wabaAccountId], references: [id], onDelete: Restrict)",
    );
    expect(phone).toContain("@@unique([wabaAccountId, metaPhoneNumberId])");
    expect(phone).toContain("@@index([wabaAccountId])");
  });

  it("binds conversations to nullable tenant-owned phone numbers additively", () => {
    const conversation = modelBlock("Conversation");
    const phone = modelBlock("PhoneNumber");

    expect(conversation).toContain("phoneNumberId  String?");
    expect(conversation).toContain("phoneNumber    PhoneNumber?       @relation(fields: [phoneNumberId], references: [id], onDelete: Restrict)");
    expect(conversation).toContain("@@index([phoneNumberId])");
    expect(phone).toContain("conversations Conversation[]");
    expect(bindingMigration).toContain('ALTER TABLE "Conversation" ADD COLUMN "phoneNumberId" TEXT');
    expect(bindingMigration).not.toMatch(/UPDATE\s+"Conversation"/i);
    expect(bindingMigration).toContain('ON DELETE RESTRICT');
  });

  it("keeps existing legacy WabaSettings structurally compatible", () => {
    const settings = modelBlock("WabaSettings");

    expect(settings).toContain('id                 String   @id @default("default")');
    expect(settings).toContain("wabaId             String?");
    expect(settings).toContain("phoneNumberId      String?");
    expect(settings).toContain("accessTokenEnc     String?");
  });

  it("documents that multi-tenancy is not operational in this task", () => {
    expect(schema).toContain("Multi-tenancy is not operational in WA-01-01.");
  });

  it("adds only non-destructive migration operations", () => {
    expect(migration).toContain('CREATE TABLE "Tenant"');
    expect(migration).toContain('CREATE TABLE "WabaAccount"');
    expect(migration).toContain('CREATE TABLE "PhoneNumber"');
    expect(migration).toContain('ALTER TABLE "WabaAccount" ADD CONSTRAINT');
    expect(migration).toContain('ALTER TABLE "PhoneNumber" ADD CONSTRAINT');
    expect(migration).not.toMatch(/\bDROP\b/i);
    expect(migration).not.toMatch(/^\s*DELETE\b/im);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
    expect(migration).not.toMatch(/ALTER TABLE "(?!WabaAccount|PhoneNumber).*DROP/i);
  });
});
