import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL || "admin@example.com";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || "123456";

  const passwordHash = await bcrypt.hash(adminPassword, 10);

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      name: "Administrator",
      role: "ADMIN",
      passwordHash,
    },
  });

  // Ensure the singleton settings row exists.
  await prisma.wabaSettings.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default", apiVersion: process.env.GRAPH_API_VERSION || "v21.0" },
  });

  console.log("Seeded admin user:");
  console.log(`  email:    ${admin.email}`);
  console.log(`  password: ${adminPassword}`);
  console.log("Change this password after first login.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
