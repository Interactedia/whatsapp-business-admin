import { handle, ok, fail } from "@/lib/api";
import { auth } from "@/auth";
import { resolveTenantContext, TenantAuthorizationError } from "@/lib/tenant";
import { tenantMessagingRepository, type MessageListPagination } from "@/lib/tenant/repository";
import { serializeMessage } from "@/lib/whatsapp/webhook";
import { resolveTemplateContents } from "@/lib/whatsapp/template-history";
import { isWithinSessionWindow } from "@/lib/whatsapp/send";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";

type ContactRead = {
  id: string;
  waId: string;
  name: string | null;
  profileName: string | null;
};

type FlowSubmissionRead = {
  id: string;
  waMessageId: string | null;
  flow: { name: string };
  response: Record<string, unknown> | null;
  responseKeys: string[];
  purgedAt: string | null;
  completedAt: string;
};

function toContactRead(raw: unknown): ContactRead | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.waId !== "string") return null;
  return {
    id: r.id,
    waId: r.waId,
    name: r.name as string | null,
    profileName: r.profileName as string | null,
  };
}

function toFlowSubmissionRead(raw: unknown): FlowSubmissionRead | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const launch = r.launch as Record<string, unknown> | null;
  if (!launch || typeof launch.id !== "string") return null;
  const flow = launch.flow as Record<string, unknown> | null;
  if (!flow || typeof flow.name !== "string") return null;
  const response = r.responseEnc
    ? (() => {
        try {
          return JSON.parse(decrypt(r.responseEnc as string)) as Record<string, unknown>;
        } catch {
          return null;
        }
      })()
    : null;
  const sensitiveFields = (flow.sensitiveFields as string[] | null) ?? [];
  const masked = response && sensitiveFields.length
    ? (Object.fromEntries(
        Object.entries(response).map(([key, value]) => [
          key,
          sensitiveFields.includes(key) ? "••••••" : value,
        ])
      ) as Record<string, unknown>)
    : response;
  return {
    id: r.id as string,
    waMessageId: r.waMessageId as string | null,
    flow: { name: flow.name as string },
    response: masked,
    responseKeys: (r.responseKeys as string[]) ?? [],
    purgedAt: r.purgedAt ? new Date(r.purgedAt as string).toISOString() : null,
    completedAt: new Date(r.completedAt as string).toISOString(),
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

  // Verify conversation + contact ownership through the repository.
  let conversation;
  try {
    conversation = await tenantMessagingRepository.findConversation(context, conversationId);
  } catch (err) {
    if (err instanceof TenantAuthorizationError) return fail(404, "Conversation not found");
    throw err;
  }
  if (!conversation) return fail(404, "Conversation not found");

  const conv = conversation as Record<string, unknown>;
  const contact = toContactRead(conv.contact);
  if (!contact) return fail(404, "Conversation not found");

  // Parse pagination from query string.
  const url = new URL(_req.url);
  const take = Math.min(Number(url.searchParams.get("take") ?? "200"), 200);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const pagination: MessageListPagination = take > 0 ? { take, ...(cursor ? { cursor } : {}) } : {};

  // Fetch messages through the tenant-scoped repository.
  let messages;
  try {
    messages = await tenantMessagingRepository.listConversationMessages(context, conversationId, pagination);
  } catch (err) {
    if (err instanceof TenantAuthorizationError) return fail(404, "Conversation not found");
    throw err;
  }

  // Resolve template contents for TEMPLATE-type messages.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const templateContents = await resolveTemplateContents(messages as any);

  // Fetch flow submissions scoped through the verified conversation ownership.
  const flowSubmissions = await prisma.flowSubmission.findMany({
    where: {
      launch: {
        conversationId: conversationId,
        conversation: {
          tenantId: context.tenantId,
          contact: { tenantId: context.tenantId },
        },
      },
    },
    include: {
      launch: { include: { flow: { select: { id: true, name: true, sensitiveFields: true } } } },
    },
    orderBy: { completedAt: "asc" },
  });

  // Mark conversation read if it has unread messages.
  const unreadCount = typeof conv.unreadCount === "number" ? conv.unreadCount : 0;
  if (unreadCount > 0) {
    await prisma.conversation.updateMany({
      where: { id: conversationId, tenantId: context.tenantId },
      data: { unreadCount: 0 },
    });
  }

  return ok({
    conversation: {
      id: conv.id as string,
      contact,
      windowOpen: isWithinSessionWindow(conv.lastInboundAt as Date | null),
      lastInboundAt: conv.lastInboundAt as string | null,
    },
    messages: (messages as Record<string, unknown>[]).map((m) =>
      serializeMessage({
        ...m,
        payload: templateContents.has(m.id as string)
          ? { templateContent: templateContents.get(m.id as string) }
          : m.payload,
      } as Parameters<typeof serializeMessage>[0])
    ),
    flowSubmissions: flowSubmissions.map((s) => toFlowSubmissionRead(s)).filter((s): s is FlowSubmissionRead => s !== null),
  });
});
