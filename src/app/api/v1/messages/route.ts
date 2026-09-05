import { z } from "zod";
import { v1Handle, apiOk, requireApiKey, ApiError, parseJsonBody } from "@/lib/v1";
import { prisma } from "@/lib/prisma";
import { ensureConversation, sendMessage, isWithinSessionWindow } from "@/lib/whatsapp/send";
import { storeFromLink } from "@/lib/whatsapp/media";
import { buildTemplateComponents, normalizeTemplateButtonInputs } from "@/lib/whatsapp/template-params";
import { templateExampleComponents, templateRuntimeComponents } from "@/lib/whatsapp/template-service";
import type { ApiComponent } from "@/lib/whatsapp/template-types";
import { finishPreparedFlowLaunch, prepareTemplateFlowLaunch } from "@/lib/whatsapp/flow-launch";

const mediaSchema = z.object({
  link: z.string().url().optional(),
  id: z.string().optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
});

const headerMediaSchema = z.object({
  type: z.enum(["image", "video", "document"]),
  link: z.string().url().optional(),
  id: z.string().optional(),
  filename: z.string().optional(),
});

const buttonSchema = z.object({
  type: z.enum(["url", "quick_reply", "copy_code"]).optional(),
  index: z.number().int().min(0).optional(),
  value: z.string(),
});

const schema = z.object({
  apikey: z.string().optional(),
  to: z.string().regex(/^\d{7,15}$/, "`to` must be digits only, no + (e.g. 919812345678)"),
  type: z.enum(["text", "image", "video", "audio", "document", "template"]).optional(),
  // text
  text: z.string().optional(),
  // media (image/video/audio/document)
  media: mediaSchema.optional(),
  // template
  template: z.string().optional(),
  language: z.string().optional(),
  variables: z.union([z.array(z.union([z.string(), z.number()])), z.record(z.string(), z.union([z.string(), z.number()]))]).optional(),
  body_variables: z.union([z.array(z.union([z.string(), z.number()])), z.record(z.string(), z.union([z.string(), z.number()]))]).optional(),
  header_text: z.string().optional(),
  header_media: headerMediaSchema.optional(),
  buttons: z.array(buttonSchema).optional(),
  components: z.array(z.unknown()).optional(),
  flow_data: z.record(z.string(), z.unknown()).optional(),
});

const MEDIA_TYPES = ["image", "video", "audio", "document"] as const;

/**
 * POST /api/v1/messages — send a text, media, or template message.
 *
 * Text:     { "to":"91…", "type":"text", "text":"Hi" }
 * Media:    { "to":"91…", "type":"image", "media":{ "link":"https://…/pic.jpg", "caption":"…" } }
 * Document: { "to":"91…", "type":"document", "media":{ "link":"https://…/f.pdf", "filename":"invoice.pdf" } }
 * Template: { "to":"91…", "type":"template", "template":"order_update", "language":"en_US",
 *             "header_text":"SALE", "body_variables":["Priya","#A123"],
 *             "header_media":{ "type":"image", "link":"https://…/banner.jpg" },
 *             "buttons":[{ "type":"url", "index":0, "value":"order/123" }] }
 * Template with named variables: "body_variables":{"first_name":"Priya","order_number":"#A123"}
 */
export const POST = v1Handle(async (req) => {
  const raw = await parseJsonBody(req);
  const body = schema.parse(raw);
  await requireApiKey(req, body);

  const type = body.type ?? (body.template ? "template" : body.media ? "image" : "text");
  const { contact, conversation } = await ensureConversation(body.to);

  const windowOpen = async () => {
    const fresh = await prisma.conversation.findUnique({ where: { id: conversation.id } });
    return isWithinSessionWindow(fresh?.lastInboundAt ?? null);
  };
  const outsideWindowError = () =>
    new ApiError(
      403,
      "Recipient is outside the 24-hour window; free-form messages are not allowed. Send an approved template instead.",
    );

  // ---- Text ----
  if (type === "text") {
    if (!body.text) throw new ApiError(400, "`text` is required for text messages");
    if (!(await windowOpen())) throw outsideWindowError();
    const msg = await sendMessage({
      conversationId: conversation.id,
      to: body.to,
      content: { kind: "text", text: body.text },
    });
    return apiOk({ message_id: msg.waMessageId, id: msg.id, to: body.to }, 201);
  }

  // ---- Media (image / video / audio / document) ----
  if ((MEDIA_TYPES as readonly string[]).includes(type)) {
    const media = body.media;
    if (!media || (!media.link && !media.id)) {
      throw new ApiError(400, "`media.link` or `media.id` is required for media messages");
    }
    if (!(await windowOpen())) throw outsideWindowError();

    // Best-effort local copy (only when sent by link) so the inbox renders it.
    let stored: { path: string; mime: string } | null = null;
    if (media.link) stored = await storeFromLink(media.link);

    const msg = await sendMessage({
      conversationId: conversation.id,
      to: body.to,
      content: {
        kind: "media",
        mediaType: type as "image" | "video" | "audio" | "document",
        mediaLink: media.link,
        mediaId: media.id,
        caption: media.caption,
        filename: media.filename,
        mediaPath: stored?.path,
        mediaMime: stored?.mime,
      },
    });
    return apiOk({ message_id: msg.waMessageId, id: msg.id, to: body.to }, 201);
  }

  // ---- Template ----
  if (!body.template) throw new ApiError(400, "`template` (name) is required for template messages");
  const template = await prisma.template.findFirst({
    where: {
      name: body.template,
      status: "APPROVED",
      ...(body.language ? { language: body.language } : {}),
    },
  });
  if (!template) {
    throw new ApiError(404, `No approved template named "${body.template}"${body.language ? ` (${body.language})` : ""}`);
  }

  const normalizedButtons = body.components?.length
    ? body.buttons
    : normalizeTemplateButtonInputs(template.components as unknown as ApiComponent[], body.buttons);
  let components = buildTemplateComponents({
    body_variables: body.body_variables,
    variables: body.variables,
    header_text: body.header_text,
    header_media: body.header_media,
    buttons: normalizedButtons,
    components: body.components,
  });
  const suppliedBodyVariables = body.body_variables ?? body.variables;
  if (template.category === "AUTHENTICATION" && suppliedBodyVariables && !body.components?.length) {
    const stringVariables = Array.isArray(suppliedBodyVariables)
      ? suppliedBodyVariables.map(String)
      : Object.fromEntries(Object.entries(suppliedBodyVariables).map(([name, value]) => [name, String(value)]));
    components = templateRuntimeComponents(
      template.components as unknown as ApiComponent[],
      template.category,
      stringVariables,
    );
  }
  // If the caller supplied no parameters, fall back to the template's saved
  // sample values so a bare { template, to } call still works.
  if (components.length === 0) {
    components = templateExampleComponents(
      template.components as unknown as ApiComponent[],
      template.category,
    );
  }
  const prepared = await prepareTemplateFlowLaunch({
    templateComponents: template.components as unknown as ApiComponent[],
    contactId: contact.id,
    conversationId: conversation.id,
    initialData: body.flow_data,
  });
  if (prepared) {
    // The server always owns Flow tokens; never accept a caller-supplied token
    // through raw template components.
    components = components.filter((component) => {
      const value = component as { type?: string; sub_type?: string };
      return !(value.type === "button" && value.sub_type === "flow");
    });
    components.push(prepared.sendComponent);
  }

  try {
    const msg = await sendMessage({
      conversationId: conversation.id,
      to: body.to,
      content: {
        kind: "template",
        templateId: template.id,
        templateName: template.name,
        language: template.language,
        components,
        preview: `Template: ${template.name}`,
      },
    });
    if (prepared) await finishPreparedFlowLaunch(prepared.launchId, msg.id);
    return apiOk({ message_id: msg.waMessageId, id: msg.id, to: body.to, ...(prepared ? { flow_launch_id: prepared.launchId } : {}) }, 201);
  } catch (error) {
    if (prepared) await finishPreparedFlowLaunch(prepared.launchId, undefined, error);
    throw error;
  }
});
