/**
 * Integration verification for WA-TYPING-INDICATOR using Acme Corp tenant.
 *
 * Verifies the typing service directly against the local PostgreSQL database
 * using the real "Acme Corp" tenant (id: "acme") and contact "5219999921444".
 *
 * Meta Graph API HTTP calls are mocked at the graphFetch boundary to prevent
 * external network requests during test runs (invariant: no real Meta API traffic).
 *
 * Run with:
 *   npx tsx test/integration/typing-indicator.test.ts
 */

import { prisma } from "@/lib/prisma";
import { resolveTenantContext, TenantAuthorizationError } from "@/lib/tenant";

async function main() {
  const checks: { label: string; ok: boolean; detail?: string }[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checks.push({ label, ok, detail });
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
  };

  try {
    // 1. Verify Acme Corp tenant exists in PostgreSQL
    const tenant = await prisma.tenant.findUnique({
      where: { id: "acme" },
      include: {
        tenantMemberships: { include: { user: true } },
        wabaAccounts: { include: { phoneNumbers: true } },
      },
    });

    check("Acme Corp tenant exists in database", !!tenant && tenant.name === "Acme Corp", tenant?.id);
    if (!tenant) throw new Error("Acme Corp tenant not found in database");

    // 2. Verify contact 5219999921444 belongs to Acme Corp
    const contact = await prisma.contact.findFirst({
      where: { tenantId: "acme", waId: "5219999921444" },
      include: {
        conversations: {
          include: {
            phoneNumber: true,
            messages: {
              where: { direction: "IN" },
              take: 5,
            },
          },
        },
      },
    });

    check("Acme Corp test contact 5219999921444 exists", !!contact, contact?.waId);
    if (!contact) throw new Error("Test contact 5219999921444 not found");

    const conversation = contact.conversations[0];
    check("Conversation exists for test contact", !!conversation, conversation?.id);
    if (!conversation) throw new Error("Conversation not found for test contact");

    const inboundMessage = conversation.messages.find((m) => m.waMessageId !== null);
    check("Inbound message with waMessageId exists", !!inboundMessage, inboundMessage?.waMessageId ?? undefined);
    if (!inboundMessage || !inboundMessage.waMessageId) throw new Error("Inbound message with waMessageId not found");

    // Record initial unreadCount
    const initialUnreadCount = conversation.unreadCount;

    // 3. Resolve real TenantContext for Acme Corp admin
    const adminMembership = tenant.tenantMemberships.find((m) => m.user.role === "ADMIN");
    if (!adminMembership) throw new Error("No admin membership found for Acme Corp");

    const tenantContext = await resolveTenantContext(
      { userId: adminMembership.userId },
      "acme",
    );
    check("TenantContext resolved for Acme Corp", tenantContext.tenantId === "acme");

    // 4. Enable typing indicator capability for this run
    process.env.WHATSAPP_TYPING_ENABLED = "true";

    // Intercept globalThis.fetch so no real network traffic hits Meta
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    let lastFetchUrl = "";
    let lastFetchInit: RequestInit | undefined = undefined;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls++;
      lastFetchUrl = String(input);
      lastFetchInit = init;
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const { sendTypingIndicator } = await import("@/lib/whatsapp/typing/service");

    // 5. Test: markAsRead omitted or false is rejected
    const unconfirmedResult = await sendTypingIndicator({
      context: tenantContext,
      conversationId: conversation.id,
      inboundMessageId: inboundMessage.id,
      markAsRead: false,
    });
    check(
      "Rejects without explicit markAsRead: true",
      !unconfirmedResult.success && unconfirmedResult.reason?.includes("markAsRead"),
      unconfirmedResult.reason,
    );
    check("No Meta request made when markAsRead is false", fetchCalls === 0);

    // 6. Test: valid sendTypingIndicator with Acme Corp data
    const successResult = await sendTypingIndicator({
      context: tenantContext,
      conversationId: conversation.id,
      inboundMessageId: inboundMessage.id,
      markAsRead: true,
    });

    check("sendTypingIndicator succeeds with Acme Corp", successResult.success, successResult.reason);
    check("Meta HTTP fetch called exactly once", fetchCalls === 1);

    const body = lastFetchInit?.body ? JSON.parse(String(lastFetchInit.body)) : {};
    check("Meta payload messaging_product is whatsapp", body.messaging_product === "whatsapp");
    check("Meta payload status is read", body.status === "read");
    check("Meta payload message_id matches inbound wamid", body.message_id === inboundMessage.waMessageId);
    check("Meta payload includes typing_indicator text", (body.typing_indicator as { type?: string })?.type === "text");
    check("Meta request URL includes phoneNumberId", lastFetchUrl.includes("/messages"));

    // 7. Test: unreadCount is NOT mutated
    const conversationAfter = await prisma.conversation.findUnique({
      where: { id: conversation.id },
    });
    check(
      "Conversation unreadCount unchanged in database",
      conversationAfter?.unreadCount === initialUnreadCount,
      `before: ${initialUnreadCount}, after: ${conversationAfter?.unreadCount}`,
    );

    // 8. Test: Cross-tenant isolation (foreign tenant context)
    let crossTenantBlocked = false;
    try {
      const foreignContext = {
        tenantId: "foreign-tenant-id",
        userId: "foreign-user",
        membershipId: "foreign-membership",
      };
      await sendTypingIndicator({
        context: foreignContext,
        conversationId: conversation.id,
        inboundMessageId: inboundMessage.id,
        markAsRead: true,
      });
    } catch (err) {
      if (err instanceof TenantAuthorizationError) {
        crossTenantBlocked = true;
      }
    }
    check("Cross-tenant request blocked with TenantAuthorizationError", crossTenantBlocked);

    // Restore original fetch
    globalThis.fetch = originalFetch;

  } catch (error) {
    check("Unhandled integration test error", false, error instanceof Error ? error.message : String(error));
  } finally {
    await prisma.$disconnect();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\nResults: ${checks.length - failed.length}/${checks.length} passed.`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

main();
