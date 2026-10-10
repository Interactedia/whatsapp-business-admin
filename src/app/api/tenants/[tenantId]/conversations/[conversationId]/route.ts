import { z } from "zod";
import { handle, ok, fail } from "@/lib/api";
import { auth } from "@/auth";
import { resolveTenantContext, TenantAuthorizationError } from "@/lib/tenant";
import { tenantMessagingRepository } from "@/lib/tenant/repository";

type ConversationRead = {
  id: string;
  contactId: string;
  status: "OPEN" | "CLOSED";
  unreadCount: number;
  lastMessageAt: Date | null;
  lastInboundAt: Date | null;
  lastPreview: string | null;
  assignedUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toConversationRead(raw: unknown): ConversationRead | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.contactId !== "string") return null;
  if (r.status !== "OPEN" && r.status !== "CLOSED") return null;
  return {
    id: r.id,
    contactId: r.contactId,
    status: r.status,
    unreadCount: typeof r.unreadCount === "number" ? r.unreadCount : 0,
    lastMessageAt: r.lastMessageAt as Date | null,
    lastInboundAt: r.lastInboundAt as Date | null,
    lastPreview: r.lastPreview as string | null,
    assignedUserId: r.assignedUserId as string | null,
    createdAt: r.createdAt as Date,
    updatedAt: r.updatedAt as Date,
  };
}

export const GET = handle(async (_req, { params }) => {
  const session = await auth();
  if (!session?.user) {
    return fail(401, "Unauthorized");
  }

  const principal = { userId: session.user.id };
  const { tenantId, conversationId } = await params;

  let context;
  try {
    context = await resolveTenantContext(principal, tenantId);
  } catch (err) {
    if (err instanceof TenantAuthorizationError) return fail(403, "Tenant access denied");
    throw err;
  }

  let conversation;
  try {
    conversation = await tenantMessagingRepository.findConversation(context, conversationId);
  } catch (err) {
    // Malformed conversationId is treated as unknown — no ownership disclosure.
    if (err instanceof TenantAuthorizationError) return fail(404, "Conversation not found");
    throw err;
  }
  const body = toConversationRead(conversation);
  if (!body) return fail(404, "Conversation not found");

  return ok(body);
});

const updateSchema = z.object({
  status: z.enum(["OPEN", "CLOSED"]).optional(),
  unreadCount: z.number().int().min(0).optional(),
  assignedUserId: z.string().nullable().optional(),
});

/** Update conversation fields (status, unreadCount, assignedUser). Enforces tenant ownership. */
export const PATCH = handle(async (req, { params }) => {
  const session = await auth();
  if (!session?.user) {
    return fail(401, "Unauthorized");
  }

  const principal = { userId: session.user.id };
  const { tenantId, conversationId } = await params;

  let context;
  try {
    context = await resolveTenantContext(principal, tenantId);
  } catch (err) {
    if (err instanceof TenantAuthorizationError) return fail(403, "Tenant access denied");
    throw err;
  }

  let body;
  try {
    body = updateSchema.parse(await req.json());
  } catch {
    return fail(400, "Invalid request");
  }

  if (Object.keys(body).length === 0) return fail(400, "No fields to update");

  let updated;
  try {
    updated = await tenantMessagingRepository.updateConversation(context, conversationId, body);
  } catch (err) {
    if (err instanceof TenantAuthorizationError) return fail(404, "Conversation not found");
    throw err;
  }

  if (!updated) return fail(404, "Conversation not found");

  const result = toConversationRead(updated);
  if (!result) return fail(500, "Internal error");

  return ok(result);
});
