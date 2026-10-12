import assert from "node:assert/strict";

async function main() {
  const { prisma } = await import("@/lib/prisma");

  const runId = `identity_${Date.now()}`;
  const tenantA = `${runId}_tA`;
  const tenantB = `${runId}_tB`;
  const sharedWaId = `${Date.now()}9999`;

  console.log("Starting Tenant-Scoped Contact and Conversation Identity Integration Tests...");

  try {
    // Setup Tenants
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, $2, NOW()), ($3, $4, NOW())`,
      tenantA,
      "Tenant A",
      tenantB,
      "Tenant B"
    );

    // Create contact with same waId in Tenant A
    const contactA = await prisma.contact.create({
      data: {
        tenantId: tenantA,
        waId: sharedWaId,
        name: "Contact in Tenant A",
      },
    });

    // Create contact with same waId in Tenant B (must succeed)
    const contactB = await prisma.contact.create({
      data: {
        tenantId: tenantB,
        waId: sharedWaId,
        name: "Contact in Tenant B",
      },
    });

    assert.notEqual(contactA.id, contactB.id, "Contact IDs should be distinct");
    assert.equal(contactA.waId, contactB.waId, "waIds should match");
    assert.equal(contactA.tenantId, tenantA, "contactA belongs to tenantA");
    assert.equal(contactB.tenantId, tenantB, "contactB belongs to tenantB");

    // Verify tenant-scoped lookups
    const lookupA = await prisma.contact.findFirst({
      where: { tenantId: tenantA, waId: sharedWaId },
    });
    const lookupB = await prisma.contact.findFirst({
      where: { tenantId: tenantB, waId: sharedWaId },
    });

    assert.equal(lookupA?.id, contactA.id, "lookupA should resolve contactA");
    assert.equal(lookupB?.id, contactB.id, "lookupB should resolve contactB");

    // Verify collision inside the same tenant is prevented
    let duplicateRejected = false;
    try {
      await prisma.contact.create({
        data: {
          tenantId: tenantA,
          waId: sharedWaId,
          name: "Duplicate Contact in Tenant A",
        },
      });
    } catch {
      duplicateRejected = true;
    }
    assert.ok(duplicateRejected, "Duplicate contact within the same tenant must be rejected");

    console.log("✓ Tenant-scoped contact separation verified successfully.");

    // ---- Multi-phone Conversation Verification ----
    const wabaId = `${runId}_waba`;
    const phone1 = `${runId}_phone1`;
    const phone2 = `${runId}_phone2`;

    await prisma.$executeRawUnsafe(
      `INSERT INTO "WabaAccount" ("id", "tenantId", "metaWabaId", "updatedAt") VALUES ($1, $2, $3, NOW())`,
      wabaId,
      tenantA,
      `${runId}_meta_waba`
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "PhoneNumber" ("id", "wabaAccountId", "metaPhoneNumberId", "updatedAt") VALUES ($1, $2, $3, NOW()), ($4, $5, $6, NOW())`,
      phone1,
      wabaId,
      `${runId}_meta_p1`,
      phone2,
      wabaId,
      `${runId}_meta_p2`
    );

    // Create conversation bound to Phone 1
    const conv1 = await prisma.conversation.create({
      data: {
        tenantId: tenantA,
        contactId: contactA.id,
        phoneNumberId: phone1,
      },
    });

    // Create conversation bound to Phone 2 for the same contact
    const conv2 = await prisma.conversation.create({
      data: {
        tenantId: tenantA,
        contactId: contactA.id,
        phoneNumberId: phone2,
      },
    });

    assert.notEqual(conv1.id, conv2.id, "Conversations on different phones must be distinct");
    assert.equal(conv1.phoneNumberId, phone1);
    assert.equal(conv2.phoneNumberId, phone2);

    console.log("✓ Multi-phone conversation isolation verified successfully.");
  } finally {
    // Cleanup
    await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "tenantId" IN ($1, $2)`, tenantA, tenantB);
    await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "tenantId" IN ($1, $2)`, tenantA, tenantB);
    await prisma.$executeRawUnsafe(`DELETE FROM "PhoneNumber" WHERE "wabaAccountId" LIKE '${runId}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "WabaAccount" WHERE "id" LIKE '${runId}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" IN ($1, $2)`, tenantA, tenantB);
  }
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
