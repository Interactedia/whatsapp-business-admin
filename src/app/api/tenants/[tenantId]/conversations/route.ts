import { z } from "zod";
import { handle, ok, fail } from "@/lib/api";
import { auth } from "@/auth";
import { resolveTenantContext, TenantAuthorizationError } from "@/lib/tenant";
import { tenantMessagingRepository } from "@/lib/tenant/repository";
import { startTenantConversation } from "@/lib/tenant/conversations";
import { isWithinSessionWindow } from "@/lib/whatsapp/send";
import { prisma } from "@/lib/prisma";

type ConversationRead = {
  id: string;
  contact: {
    id: string;
    waId: string;
    name: string | null;
    profileName: string | null;
    tags: string[];
  };
  status: "OPEN" | "CLOSED";
  unreadCount: number;
  lastMessageAt: Date | null;
  lastInboundAt: Date | null;
  lastPreview: string | null;
  assignedUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  windowOpen: boolean;
};

function toConversationRead(raw: unknown): ConversationRead | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") return null;
  if (r.status !== "OPEN" && r.status !== "CLOSED") return null;
  const contact = r.contact as Record<string, unknown> | null;
  if (!contact || typeof contact.id !== "string" || typeof contact.waId !== "string") return null;
  return {
    id: r.id,
    contact: {
      id: contact.id,
      waId: contact.waId,
      name: contact.name as string | null,
      profileName: contact.profileName as string | null,
      tags: (contact.tags as string[]) ?? [],
    },
    status: r.status,
    unreadCount: typeof r.unreadCount === "number" ? r.unreadCount : 0,
    lastMessageAt: r.lastMessageAt as Date | null,
    lastInboundAt: r.lastInboundAt as Date | null,
    lastPreview: r.lastPreview as string | null,
    assignedUserId: r.assignedUserId as string | null,
    createdAt: r.createdAt as Date,
    updatedAt: r.updatedAt as Date,
    windowOpen: isWithinSessionWindow(r.lastInboundAt as Date | null),
  };
}

export const GET = handle(async (_req, { params }) => {
  const session = await auth();
  if (!session?.user) {
    return fail(401, "Unauthorized");
  }

  const principal = { userId: session.user.id };
  const { tenantId } = await params;

  let context;
  try {
    context = await resolveTenantContext(principal, tenantId);
  } catch (err) {
    if (err instanceof TenantAuthorizationError) return fail(403, "Tenant access denied");
    throw err;
  }

  let conversations;
  try {
    conversations = await tenantMessagingRepository.listConversations(context, { take: 200 });
  } catch (err) {
    if (err instanceof TenantAuthorizationError) return fail(400, "Invalid request");
    throw err;
  }

  const body = conversations
    .map((c) => toConversationRead(c))
    .filter((c): c is ConversationRead => c !== null);

  return ok(body);
});

const startSchema = z.object({
  waId: z.string().trim().regex(/^\d{7,15}$/, "Enter digits only, no + (e.g. 919812345678)"),
  name: z.string().trim().optional(),
  // ponytail: optional — when the caller (the contacts UI) does not know
  // which phone number the tenant is sending from, the server resolves the
  // only PhoneNumber on the tenant's WabaAccount. If the caller wants a
  // specific phone, it can still pass it explicitly.
  phoneNumberId: z.string().trim().min(1).max(191).optional(),
});

/** Start (or resume) a conversation for a phone number, owned by the verified tenant. */
export const POST = handle(async (req, { params }) => {
  const session = await auth();
  if (!session?.user) {
    return fail(401, "Unauthorized");
  }

  const principal = { userId: session.user.id };
  const { tenantId } = await params;

  let context;
  try {
    context = await resolveTenantContext(principal, tenantId);
  } catch (err) {
    if (err instanceof TenantAuthorizationError) return fail(403, "Tenant access denied");
    throw err;
  }

  let body;
  try {
    body = startSchema.parse(await req.json());
  } catch {
    return fail(400, "Invalid request");
  }

  // ponytail: resolve the tenant's only PhoneNumber if the caller did not
  // specify one. The contacts UI does not know which phone the tenant is
  // sending from; assuming "the one configured phone" matches the
  // single-phone-per-tenant deployment shape.
  let phoneNumberId = body.phoneNumberId;
  if (!phoneNumberId) {
    const phones = await prisma.phoneNumber.findMany({
      where: { wabaAccount: { tenantId: context.tenantId } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    if (phones.length === 0) return fail(409, "Tenant has no phone number configured. Set one in Settings.");
    if (phones.length > 1) return fail(409, "Tenant has multiple phone numbers; specify phoneNumberId in the request.");
    phoneNumberId = phones[0]!.id;
  }

  let result;
  try {
    result = await startTenantConversation({ context, ...body, phoneNumberId });
  } catch (err) {
    if (err instanceof TenantAuthorizationError) return fail(403, "Tenant access denied");
    throw err;
  }

  const conv = result as { id: string; contactId: string; phoneNumberId: string | null };
  return ok({ id: conv.id, contactId: conv.contactId, phoneNumberId: conv.phoneNumberId }, 201);
});
