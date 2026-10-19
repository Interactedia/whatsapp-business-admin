/**
 * POST /api/tenants/[tenantId]/conversations/[conversationId]/typing
 *
 * Operator-typing indicator. The browser fires this while the user is typing
 * a reply; the handler resolves the most recent inbound message and calls
 * the WhatsApp typing service, which (per Meta's API) also marks that
 * message as read on the customer's device.
 *
 * Authorization:
 *   - session user must be ADMIN or AGENT
 *   - conversation + tenant ownership verified via the same
 *     resolveTenantContext pipeline as the messages endpoint
 *   - a non-empty draft is required (server-side guard so a stuck client
 *     cannot spam Meta)
 *
 * Rate control (WA-TYPING-01 simplified): the service applies an atomic
 * Redis cooldown per (tenant, sender phone number, recipient). At most one
 * typing request reaches Meta per window; everything else is discarded
 * before being enqueued. Nothing is scheduled for future dispatch, so no
 * typing request can fire after the operator pressed Send.
 */
import { z } from "zod";
import { handle, ok, fail, HttpError } from "@/lib/api";
import { auth } from "@/auth";
import { resolveTenantContext, TenantAuthorizationError } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { sendTypingIndicator } from "@/lib/whatsapp/typing";

const bodySchema = z.object({
  draft: z.string().trim().min(1).max(4096),
});

export const POST = handle(async (req, { params }) => {
  const session = await auth();
  if (!session?.user) return fail(401, "Unauthorized");

  const { tenantId, conversationId } = await params;

  let context;
  try {
    context = await resolveTenantContext({ userId: session.user.id }, tenantId);
  } catch (err) {
    if (err instanceof TenantAuthorizationError) return fail(403, "Tenant access denied");
    throw err;
  }

  // ponytail: parse after auth so a malformed body cannot trigger a tenant
  // lookup. The parsed draft is not used further — validation itself is the
  // point (non-empty draft required so a stuck client cannot spam Meta).
  bodySchema.parse(await req.json());

  // Verify the conversation belongs to this tenant.
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId, contact: { tenantId } },
  });
  if (!conversation) return fail(404, "Conversation not found");

  // Most recent inbound message on the thread. The Meta typing indicator is
  // always coupled to a message_id; if the customer has not sent anything
  // there is nothing to attach the indicator to and we no-op cleanly.
  const lastInbound = await prisma.message.findFirst({
    where: { conversationId, direction: "IN" },
    orderBy: { timestamp: "desc" },
    select: { id: true },
  });
  if (!lastInbound) {
    return ok({ sent: false, reason: "no inbound message to attach the indicator to" });
  }

  const result = await sendTypingIndicator({
    context,
    conversationId,
    inboundMessageId: lastInbound.id,
    markAsRead: true, // ponytail: Meta's API requires this; service refuses otherwise
  });

  return ok({
    sent: result.success,
    reason: result.reason ?? null,
  });
});
