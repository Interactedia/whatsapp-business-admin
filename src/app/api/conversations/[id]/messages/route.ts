import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { handle, ok, requireUser, HttpError } from "@/lib/api";
import { serializeMessage } from "@/lib/whatsapp/webhook";
import { sendMessage, isWithinSessionWindow, type OutboundContent } from "@/lib/whatsapp/send";
import { uploadOutboundMedia } from "@/lib/whatsapp/media";
import { mediaStore, extFromMime } from "@/lib/media";
import { templateExampleComponents, templateRuntimeComponents } from "@/lib/whatsapp/template-service";
import { extractVariables, isNamedToken, type ApiComponent } from "@/lib/whatsapp/template-types";
import { presentFlowSubmission } from "@/lib/whatsapp/flow-present";
import { finishPreparedFlowLaunch, launchFlow, prepareTemplateFlowLaunch } from "@/lib/whatsapp/flow-launch";

/** Fetch the thread (oldest → newest) and mark it read. */
export const GET = handle(async (_req, { params }) => {
  const session = await requireUser();
  const { id } = await params;
  const conversation = await prisma.conversation.findUnique({ where: { id }, include: { contact: true } });
  if (!conversation) throw new HttpError(404, "Conversation not found");

  const messages = await prisma.message.findMany({
    where: { conversationId: id },
    orderBy: { timestamp: "asc" },
    take: 200,
  });
  const flowSubmissions = await prisma.flowSubmission.findMany({
    where: { launch: { conversationId: id } },
    include: { launch: { include: { flow: true } } },
    orderBy: { completedAt: "asc" },
  });

  // Mark read.
  if (conversation.unreadCount > 0) {
    await prisma.conversation.update({ where: { id }, data: { unreadCount: 0 } });
  }

  return ok({
    conversation: {
      id: conversation.id,
      contact: conversation.contact,
      windowOpen: isWithinSessionWindow(conversation.lastInboundAt),
      lastInboundAt: conversation.lastInboundAt,
    },
    messages: messages.map(serializeMessage),
    flowSubmissions: flowSubmissions.map((submission) => presentFlowSubmission(submission, session.user.role === "ADMIN")),
  });
});

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
 */
export const POST = handle(async (req, { params }) => {
  const session = await requireUser();
  const { id } = await params;

  const conversation = await prisma.conversation.findUnique({ where: { id }, include: { contact: true } });
  if (!conversation) throw new HttpError(404, "Conversation not found");
  const to = conversation.contact.waId;
  const windowOpen = isWithinSessionWindow(conversation.lastInboundAt);

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

    // Upload to Meta, and keep a local copy so the thread can render it.
    const mediaId = await uploadOutboundMedia({ data: buffer, mimeType: mime, fileName: file.name });
    const localPath = await mediaStore.save(buffer, extFromMime(mime));

    const message = await sendMessage({
      conversationId: id,
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

  // ---- Text / Template (JSON) ----
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

    const prepared = await prepareTemplateFlowLaunch({ templateComponents, contactId: conversation.contact.id, conversationId: id });
    const sendComponents = bodyVariables
      ? templateRuntimeComponents(templateComponents, template.category, bodyVariables)
      : templateExampleComponents(templateComponents, template.category);
    const content: OutboundContent = {
      kind: "template",
      templateId: template.id,
      templateName: template.name,
      language: template.language,
      components: [
        ...sendComponents,
        ...(prepared ? [prepared.sendComponent] : []),
      ],
      preview: `Template: ${template.name}`,
    };
    try {
      const message = await sendMessage({ conversationId: id, to, sentById: session.user.id, content });
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
    conversationId: id,
    to,
    sentById: session.user.id,
    content: { kind: "text", text: parsed.text },
  });
  return ok(serializeMessage(message), 201);
});
