import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";

const DEMO_PASSWORD = "123456";

function resolveSeedPassword() {
  const configured = process.env.SEED_ADMIN_PASSWORD;
  if (configured) return configured;

  if (process.env.NODE_ENV === "test" || process.env.WBA_ALLOW_DEMO_SEED === "true") {
    return DEMO_PASSWORD;
  }

  throw new Error(
    "SEED_ADMIN_PASSWORD is required outside test/demo seed mode. " +
      "Set WBA_ALLOW_DEMO_SEED=true only for isolated local fixtures.",
  );
}

async function main() {
  const seedPassword = resolveSeedPassword();
  const passwordHash = await bcrypt.hash(seedPassword, 10);

  // 1. Ensure the two tenants exist
  const tenant1 = await prisma.tenant.upsert({
    where: { id: "cmv337nob0001t25hbbyuq8tk" },
    update: { name: "Default Organization" },
    create: { id: "cmv337nob0001t25hbbyuq8tk", name: "Default Organization" },
  });

  const tenant2 = await prisma.tenant.upsert({
    where: { id: "acme" },
    update: { name: "Acme Corp" },
    create: { id: "acme", name: "Acme Corp" },
  });

  // 2. Seed SYSTEM_ADMIN
  await prisma.user.upsert({
    where: { email: "admin@superadmin.com" },
    update: { role: "SYSTEM_ADMIN", passwordHash, active: true },
    create: {
      email: "admin@superadmin.com",
      name: "Super Administrator",
      role: "SYSTEM_ADMIN",
      passwordHash,
    },
  });

  // 3. Seed Tenant 1 ADMIN (Default Organization only)
  const defaultAdmin = await prisma.user.upsert({
    where: { email: "admin@default.com" },
    update: { role: "ADMIN", passwordHash, active: true },
    create: {
      email: "admin@default.com",
      name: "Default Org Admin",
      role: "ADMIN",
      passwordHash,
    },
  });

  // 4. Seed Tenant 2 ADMIN (Acme Corp only)
  const acmeAdmin = await prisma.user.upsert({
    where: { email: "admin@acme.com" },
    update: { role: "ADMIN", passwordHash, active: true },
    create: {
      email: "admin@acme.com",
      name: "Acme Corp Admin",
      role: "ADMIN",
      passwordHash,
    },
  });

  // 5. Ensure memberships.
  // The SYSTEM_ADMIN is a pure platform administrator: this seed never creates
  // tenant memberships for it. Tenant ADMINs are members of exactly one tenant.
  await prisma.tenantMembership.upsert({
    where: { userId_tenantId: { userId: defaultAdmin.id, tenantId: tenant1.id } },
    update: {},
    create: { userId: defaultAdmin.id, tenantId: tenant1.id },
  });
  await prisma.tenantMembership.upsert({
    where: { userId_tenantId: { userId: acmeAdmin.id, tenantId: tenant2.id } },
    update: {},
    create: { userId: acmeAdmin.id, tenantId: tenant2.id },
  });

  // 6. Ensure singleton settings row exists
  await prisma.wabaSettings.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default", apiVersion: process.env.GRAPH_API_VERSION || "v21.0" },
  });

  console.log("Seeded administrative users successfully:");
  console.log("  1. System Admin:     admin@superadmin.com (role: SYSTEM_ADMIN, pass: " + seedPassword + ")");
  console.log("  2. Default Org Admin: admin@default.com    (role: ADMIN,        pass: " + seedPassword + ") -> [Default Organization]");
  console.log("  3. Acme Corp Admin:   admin@acme.com       (role: ADMIN,        pass: " + seedPassword + ") -> [Acme Corp]");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
