import assert from "node:assert/strict";

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { TenantAuthorizationError, resolveTenantContext } = await import("@/lib/tenant");
  const { createTenantConversation, startTenantConversation } = await import("@/lib/tenant/conversations");

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

    const userId = `${runId}_user`;
    const membershipA = `${runId}_membership_a`;
    const membershipB = `${runId}_membership_b`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "User" ("id", "email", "name", "passwordHash", "updatedAt") VALUES ($1, $2, $3, $4, NOW())`,
      userId,
      `${runId}@example.test`,
      "Identity Test User",
      "not-used"
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "TenantMembership" ("id", "userId", "tenantId") VALUES ($1, $2, $3), ($4, $5, $6)`,
      membershipA,
      userId,
      tenantA,
      membershipB,
      userId,
      tenantB
    );
    const contextA = await resolveTenantContext({ userId }, tenantA);
    const contextB = await resolveTenantContext({ userId }, tenantB);

    let crossTenantRejected = false;
    try {
      await createTenantConversation({ context: contextB, contactId: contactA.id, phoneNumberId: phone1 });
    } catch (error) {
      crossTenantRejected = error instanceof TenantAuthorizationError;
    }
    assert.ok(crossTenantRejected, "Cross-tenant contact resolution must fail closed");

    const concurrentWaId = `${sharedWaId}77`;
    const contactResults = await Promise.allSettled(
      Array.from({ length: 2 }, () => startTenantConversation({ context: contextA, waId: concurrentWaId, name: "Concurrent Contact", phoneNumberId: phone1 }))
    );
    const concurrentContacts = await prisma.contact.findMany({ where: { tenantId: tenantA, waId: concurrentWaId } });
    assert.equal(concurrentContacts.length, 1, "Concurrent contact creation must leave one tenant-scoped contact");
    assert.equal(contactResults.filter((result) => result.status === "fulfilled").length, 1, "One concurrent creator should win");
    assert.ok(
      contactResults.some((result) => result.status === "rejected" && isUniqueViolation(result.reason)),
      "Concurrent losing contact creator must fail on the unique constraint"
    );

    const conversationWaId = `${sharedWaId}88`;
    const conversationContact = await prisma.contact.create({ data: { tenantId: tenantA, waId: conversationWaId, name: "Concurrent Conversation" } });
    const conversationResults = await Promise.allSettled(
      Array.from({ length: 2 }, () => createTenantConversation({ context: contextA, contactId: conversationContact.id, phoneNumberId: phone2 }))
    );
    const concurrentConversations = await prisma.conversation.findMany({ where: { tenantId: tenantA, contactId: conversationContact.id, phoneNumberId: phone2 } });
    assert.equal(concurrentConversations.length, 1, "Concurrent conversation resolution must leave one tenant-phone-contact conversation");
    assert.equal(conversationResults.filter((result) => result.status === "fulfilled").length, 2, "Concurrent conversation resolution should be idempotent when the row already exists");
    assert.ok(
      conversationResults.every((result) => result.status === "fulfilled" && result.value.id === concurrentConversations[0]?.id),
      "Concurrent conversation callers must resolve the same row"
    );

    console.log("✓ Cross-tenant rejection and concurrent uniqueness verified successfully.");
  } finally {
    // Cleanup
    await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "tenantId" IN ($1, $2)`, tenantA, tenantB);
    await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "tenantId" IN ($1, $2)`, tenantA, tenantB);
    await prisma.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" IN ($1, $2)`, tenantA, tenantB);
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, `${runId}_user`);
    await prisma.$executeRawUnsafe(`DELETE FROM "PhoneNumber" WHERE "wabaAccountId" LIKE '${runId}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "WabaAccount" WHERE "id" LIKE '${runId}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" IN ($1, $2)`, tenantA, tenantB);
  }
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
