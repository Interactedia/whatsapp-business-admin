import { z } from "zod";
import { handle, ok, fail, HttpError } from "@/lib/api";
import { auth } from "@/auth";
import { resolveTenantContext, TenantAuthorizationError } from "@/lib/tenant";
import { tenantMessagingRepository, type MessageListPagination } from "@/lib/tenant/repository";
import { serializeMessage } from "@/lib/whatsapp/webhook";
import { resolveTemplateContents } from "@/lib/whatsapp/template-history";
import { isWithinSessionWindow, resolveConversationSenderConfig, sendMessage } from "@/lib/whatsapp/send";
import { uploadOutboundMedia } from "@/lib/whatsapp/media";
import { mediaStore, extFromMime } from "@/lib/media";
import { templateExampleComponents, templateRuntimeComponents } from "@/lib/whatsapp/template-service";
import { extractVariables, isNamedToken, type ApiComponent } from "@/lib/whatsapp/template-types";
import { finishPreparedFlowLaunch, launchFlow, prepareTemplateFlowLaunch } from "@/lib/whatsapp/flow-launch";
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

// ---------------------------------------------------------------------------
// POST — Send outbound message (tenant-scoped)
// ---------------------------------------------------------------------------

const textSchema = z.object({ kind: z.literal("text"), text: z.string().min(1) });
const templateSchema = z.object({
  kind: z.literal("template"),
  templateId: z.string(),
  bodyVariables: z.union([
    z.array(z.string().trim().min(1)),
    z.record(z.string(), z.string().trim().min(1)),
  ]).optional(),
});
const flowSchema = z.object({
  kind: z.literal("flow"),
  flowId: z.string(),
  cta: z.string().trim().min(1).max(20).default("Open form"),
  body: z.string().trim().min(1).max(1024).optional(),
  header: z.string().trim().max(60).optional(),
  footer: z.string().trim().max(60).optional(),
  entryScreen: z.string().optional(),
  initialData: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Send a message. JSON body for text/template; multipart/form-data for media.
 * Enforces the 24h session window for free-form (text/media) messages.
 *
 * Authorization chain:
 *  1. Authenticate principal via NextAuth session.
 *  2. Verify TenantMembership → TenantContext (enforces tenant membership, blocks ADMIN without membership).
 *  3. findConversation enforces conversation ownership via tenant-scoped query predicate.
 *     A cross-tenant conversation returns 404 (not an authorization leak).
 *  4. Contact.waId is extracted from the owned conversation's contact.
 *  5. sendMessage resolves provider credentials from the bound tenant-owned PhoneNumber/WABA.
 *     Unbound historical conversations fail closed before provider invocation.
 *
 * Security predicates enforced:
 *  - No unauthenticated request reaches sendMessage.
 *  - No cross-tenant conversation reaches sendMessage.
 *  - No external provider call occurs before conversation ownership is verified.
 *  - No global credential fallback is used — the singleton is the system account.
 */
export const POST = handle(async (req, { params }) => {
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

  // Verify conversation ownership through tenant-scoped repository.
  let conversation;
  try {
    conversation = await tenantMessagingRepository.findConversation(context, conversationId);
  } catch (err) {
    if (err instanceof TenantAuthorizationError) return fail(404, "Conversation not found");
    throw err;
  }
  if (!conversation) return fail(404, "Conversation not found");

  const conv = conversation as Record<string, unknown>;
  const to = (conv.contact as Record<string, unknown>)?.waId as string;
  if (!to) return fail(500, "Internal error");

  const windowOpen = isWithinSessionWindow(conv.lastInboundAt as Date | null);
  const contentType = req.headers.get("content-type") || "";

  // ---- Media (multipart) ----
  if (contentType.includes("multipart/form-data")) {
    if (!windowOpen) throw new HttpError(403, "This chat is outside the 24-hour window. Send an approved template instead.");
    const form = await req.formData();
    const file = form.get("file");
    const caption = (form.get("caption") as string) || undefined;
    if (!(file instanceof File)) throw new HttpError(400, "No file provided");

    const buffer = Buffer.from(await file.arrayBuffer());
    const mime = file.type || "application/octet-stream";
    const mediaType = mime.startsWith("image/")
      ? "image"
      : mime.startsWith("video/")
        ? "video"
        : mime.startsWith("audio/")
          ? "audio"
          : "document";

    const senderConfig = await resolveConversationSenderConfig(conversationId);
    const mediaId = await uploadOutboundMedia({ data: buffer, mimeType: mime, fileName: file.name, config: senderConfig });
    const localPath = await mediaStore.save(buffer, extFromMime(mime));

    const message = await sendMessage({
      conversationId,
      to,
      sentById: session.user.id,
      content: {
        kind: "media",
        mediaType: mediaType as "image" | "video" | "audio" | "document",
        mediaId,
        caption,
        mediaPath: localPath,
        mediaMime: mime,
        filename: file.name,
      },
    });
    return ok(serializeMessage(message), 201);
  }

  // ---- Text / Template / Flow (JSON) ----
  const body = await req.json();

  if (body.kind === "flow") {
    if (!windowOpen) throw new HttpError(403, "This chat is outside the 24-hour window. Send an approved template with a Flow button instead.");
    const parsed = flowSchema.parse(body);
    const launched = await launchFlow({ ...parsed, to, sentById: session.user.id });
    return ok(launched, 201);
  }

  if (body.kind === "template") {
    const parsed = templateSchema.parse(body);
    const template = await prisma.template.findUnique({ where: { id: parsed.templateId } });
    if (!template) throw new HttpError(404, "Template not found");
    if (template.status !== "APPROVED") throw new HttpError(400, "Only approved templates can be sent.");

    const templateComponents = template.components as unknown as ApiComponent[];
    const bodyComponent = templateComponents.find((component) => component.type === "BODY");
    const bodyTokens = extractVariables(bodyComponent?.text ?? "");
    if (bodyTokens.length > 0 && !parsed.bodyVariables) {
      throw new HttpError(400, "Enter all template parameter values before sending.");
    }
    const bodyVariables = parsed.bodyVariables;
    if (bodyVariables) {
      const named = bodyTokens.some(isNamedToken);
      if (named && Array.isArray(bodyVariables)) {
        throw new HttpError(400, "Named template parameters must be supplied by name.");
      }
      if (!named && !Array.isArray(bodyVariables)) {
        throw new HttpError(400, "Numbered template parameters must be supplied in order.");
      }
      if (Array.isArray(bodyVariables) && bodyVariables.length < bodyTokens.length) {
        throw new HttpError(400, "Enter all template parameter values before sending.");
      }
      if (!Array.isArray(bodyVariables) && bodyTokens.some((token) => !bodyVariables[token])) {
        throw new HttpError(400, "Enter all template parameter values before sending.");
      }
    }

    const contactId = (conv.contact as Record<string, unknown>)?.id as string;
    const prepared = await prepareTemplateFlowLaunch({ templateComponents, contactId, conversationId });
    const sendComponents = bodyVariables
      ? templateRuntimeComponents(templateComponents, template.category, bodyVariables)
      : templateExampleComponents(templateComponents, template.category);
    const content = {
      kind: "template" as const,
      templateId: template.id,
      templateName: template.name,
      language: template.language,
      components: [
        ...sendComponents,
        ...(prepared ? [prepared.sendComponent] : []),
      ],
      templateComponents,
    };
    try {
      const message = await sendMessage({ conversationId, to, sentById: session.user.id, content });
      if (prepared) await finishPreparedFlowLaunch(prepared.launchId, message.id);
      return ok(serializeMessage(message), 201);
    } catch (error) {
      if (prepared) await finishPreparedFlowLaunch(prepared.launchId, undefined, error);
      throw error;
    }
  }

  // text
  const parsed = textSchema.parse(body);
  if (!windowOpen) throw new HttpError(403, "This chat is outside the 24-hour window. Send an approved template instead.");
  const message = await sendMessage({
    conversationId,
    to,
    sentById: session.user.id,
    content: { kind: "text", text: parsed.text },
  });
  return ok(serializeMessage(message), 201);
});
