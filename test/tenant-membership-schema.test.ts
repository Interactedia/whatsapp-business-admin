import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
const migrationPath = join(
  process.cwd(),
  "prisma/migrations/20261009180500_add_user_tenant_memberships/migration.sql",
);
const migration = readFileSync(migrationPath, "utf8");

function modelBlock(name: string) {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`Missing model ${name}`);
  return match[1];
}

describe("WA-01-04 user tenant membership foundation", () => {
  it("defines TenantMembership with stable identifiers and timestamps", () => {
    const membership = modelBlock("TenantMembership");

    expect(membership).toContain("id        String   @id @default(cuid())");
    expect(membership).toContain("createdAt DateTime @default(now())");
  });

  it("connects User to TenantMembership without changing role semantics", () => {
    const user = modelBlock("User");
    const membership = modelBlock("TenantMembership");

    expect(user).toMatch(/role\s+Role\s+@default\(AGENT\)/);
    expect(user).toContain("tenantMemberships TenantMembership[]");
    expect(membership).toContain("userId    String");
    expect(membership).toContain(
      "user      User     @relation(fields: [userId], references: [id], onDelete: Restrict)",
    );
  });

  it("connects Tenant to TenantMembership", () => {
    const tenant = modelBlock("Tenant");
    const membership = modelBlock("TenantMembership");

    expect(tenant).toContain("tenantMemberships TenantMembership[]");
    expect(membership).toContain("tenantId  String");
    expect(membership).toContain(
      "tenant    Tenant   @relation(fields: [tenantId], references: [id], onDelete: Restrict)",
    );
  });

  it("enforces one membership per user and tenant pair", () => {
    const membership = modelBlock("TenantMembership");

    expect(membership).toContain("@@unique([userId, tenantId])");
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "TenantMembership_userId_tenantId_key" ON "TenantMembership"("userId", "tenantId");',
    );
  });

  it("indexes tenant lookups without a redundant user index", () => {
    const membership = modelBlock("TenantMembership");

    expect(membership).toContain("@@index([tenantId])");
    expect(membership).not.toContain("@@index([userId])");
    expect(migration).toContain('CREATE INDEX "TenantMembership_tenantId_idx"');
    expect(migration).not.toContain('CREATE INDEX "TenantMembership_userId_idx"');
  });

  it("creates required foreign keys with restrictive deletion", () => {
    expect(migration).toContain(
      'FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE',
    );
    expect(migration).toContain(
      'FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE',
    );
  });

  it("does not introduce automatic membership defaults", () => {
    const membership = modelBlock("TenantMembership");

    expect(membership).toMatch(/userId\s+String\n/);
    expect(membership).toMatch(/tenantId\s+String\n/);
    expect(migration).not.toMatch(/INSERT INTO\s+"TenantMembership"/i);
  });

  it("keeps authentication schema compatibility", () => {
    const user = modelBlock("User");

    expect(user).toContain("id           String   @id @default(cuid())");
    expect(user).toContain("email        String   @unique");
    expect(user).toContain("passwordHash String");
    expect(user).toContain("active       Boolean  @default(true)");
  });

  it("keeps the migration additive", () => {
    expect(migration).toContain('CREATE TABLE "TenantMembership"');
    expect(migration).toContain("CREATE UNIQUE INDEX");
    expect(migration).toContain("CREATE INDEX");
    expect(migration).toContain("ADD CONSTRAINT");
    expect(migration).not.toMatch(/\bDROP\b/i);
    expect(migration).not.toMatch(/^\s*DELETE\b/im);
    expect(migration).not.toMatch(/^\s*UPDATE\b/im);
    expect(migration).not.toMatch(/ALTER TABLE\s+"(?!TenantMembership")/i);
  });

  it("has exactly one TenantMembership migration", () => {
    const migrations = readdirSync(join(process.cwd(), "prisma/migrations"));

    expect(migrations.filter((name) => name.includes("user_tenant_memberships"))).toEqual([
      "20261009180500_add_user_tenant_memberships",
    ]);
  });
});
