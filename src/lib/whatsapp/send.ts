import { prisma } from "@/lib/prisma";
import { getWabaConfig, type WabaConfig } from "@/lib/settings";
import { graphFetch, WhatsAppApiError } from "@/lib/whatsapp/client";
import { publish } from "@/server/realtime";
import { serializeMessage } from "@/lib/whatsapp/webhook";
import type { MessageType } from "@/generated/prisma/client";

export { isWithinSessionWindow } from "@/lib/whatsapp/window";

/** Get or create the contact + conversation for a wa_id. */
export async function ensureConversation(waId: string, name?: string) {
  const contact = await prisma.contact.upsert({
    where: { waId },
    update: name ? { name } : {},
    create: { waId, name },
  });
  const conversation = await prisma.conversation.upsert({
    where: { contactId: contact.id },
    update: {},
    create: { contactId: contact.id },
  });
  return { contact, conversation };
}

export type OutboundContent =
  | { kind: "text"; text: string }
  | {
      kind: "media";
      mediaType: "image" | "video" | "audio" | "document";
      // Provide either an uploaded media id OR a public link.
      mediaId?: string;
      mediaLink?: string;
      caption?: string;
      mediaPath?: string;
      mediaMime?: string;
      filename?: string;
    }
  | { kind: "template"; templateId?: string; templateName: string; language: string; components?: unknown[]; preview?: string }
  | {
      kind: "flow";
      flowId: string;
      flowToken: string;
      cta: string;
      body: string;
      header?: string;
      footer?: string;
      entryScreen?: string;
      initialData?: Record<string, unknown>;
      action: "navigate" | "data_exchange";
      mode?: "draft" | "published";
    };

const MEDIA_TYPE_TO_ENUM: Record<string, MessageType> = {
  image: "IMAGE",
  video: "VIDEO",
  audio: "AUDIO",
  document: "DOCUMENT",
};

function buildPayload(to: string, content: OutboundContent): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to };
  switch (content.kind) {
    case "text":
      return { ...base, type: "text", text: { preview_url: true, body: content.text } };
    case "media":
      return {
        ...base,
        type: content.mediaType,
        [content.mediaType]: {
          // Prefer a link when supplied, otherwise an uploaded media id.
          ...(content.mediaLink ? { link: content.mediaLink } : { id: content.mediaId }),
          // Captions are only valid on image/video/document.
          ...(content.caption && content.mediaType !== "audio" ? { caption: content.caption } : {}),
          ...(content.mediaType === "document" && content.filename ? { filename: content.filename } : {}),
        },
      };
    case "template":
      return {
        ...base,
        type: "template",
        template: {
          name: content.templateName,
          language: { code: content.language },
          ...(content.components ? { components: content.components } : {}),
        },
      };
    case "flow":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "flow",
          ...(content.header ? { header: { type: "text", text: content.header } } : {}),
          body: { text: content.body },
          ...(content.footer ? { footer: { text: content.footer } } : {}),
          action: {
            name: "flow",
            parameters: {
              flow_message_version: "3",
              flow_token: content.flowToken,
              flow_id: content.flowId,
              flow_cta: content.cta,
              flow_action: content.action,
              mode: content.mode || "published",
              ...(content.action === "navigate" && content.entryScreen
                ? { flow_action_payload: { screen: content.entryScreen, ...(content.initialData && Object.keys(content.initialData).length ? { data: content.initialData } : {}) } }
                : {}),
            },
          },
        },
      };
  }
}

function previewFor(content: OutboundContent): string {
  switch (content.kind) {
    case "text": return content.text.slice(0, 140);
    case "media": return content.caption || `📎 ${content.mediaType}`;
    case "template": return content.preview || `Template: ${content.templateName}`;
    case "flow": return `Flow: ${content.cta}`;
  }
}

/**
 * Send an outbound message. Records a Message row (SENT or FAILED), updates the
 * conversation, and emits a realtime event. Callers enforce the 24h window.
 */
export async function sendMessage(opts: {
  conversationId: string;
  to: string;
  content: OutboundContent;
  sentById?: string;
  config?: WabaConfig;
}) {
  const cfg = opts.config ?? (await getWabaConfig());
  if (!cfg.phoneNumberId) throw new WhatsAppApiError(400, "WhatsApp is not connected.");

  const type: MessageType =
    opts.content.kind === "text"
      ? "TEXT"
      : opts.content.kind === "template"
        ? "TEMPLATE"
        : opts.content.kind === "flow"
          ? "INTERACTIVE"
        : MEDIA_TYPE_TO_ENUM[opts.content.mediaType];

  // Create a PENDING row first so a failure is still recorded.
  const message = await prisma.message.create({
    data: {
      conversationId: opts.conversationId,
      direction: "OUT",
      type,
      status: "PENDING",
      text: opts.content.kind === "text" ? opts.content.text : previewFor(opts.content),
      caption: opts.content.kind === "media" ? opts.content.caption : undefined,
      mediaPath: opts.content.kind === "media" ? opts.content.mediaPath : undefined,
      mediaMime: opts.content.kind === "media" ? opts.content.mediaMime : undefined,
      mediaFilename: opts.content.kind === "media" ? opts.content.filename : undefined,
      templateId: opts.content.kind === "template" ? opts.content.templateId : undefined,
      payload: opts.content.kind === "flow" ? { flowId: opts.content.flowId, cta: opts.content.cta } : undefined,
      sentById: opts.sentById,
    },
  });

  try {
    const res = await graphFetch<{ messages: { id: string }[] }>({
      method: "POST",
      path: `/${cfg.phoneNumberId}/messages`,
      body: buildPayload(opts.to, opts.content),
      related: { type: "message", id: message.id },
      config: cfg,
    });
    const waMessageId = res.messages?.[0]?.id;
    const updated = await prisma.message.update({
      where: { id: message.id },
      data: { status: "SENT", waMessageId },
    });
    await prisma.conversation.update({
      where: { id: opts.conversationId },
      data: { lastMessageAt: new Date(), lastPreview: previewFor(opts.content).slice(0, 140) },
    });
    publish({ type: "message:new", payload: { conversationId: opts.conversationId, message: serializeMessage(updated) } });
    return updated;
  } catch (e) {
    const failed = await prisma.message.update({
      where: { id: message.id },
      data: { status: "FAILED", errorJson: { message: e instanceof Error ? e.message : String(e) } },
    });
    publish({ type: "message:new", payload: { conversationId: opts.conversationId, message: serializeMessage(failed) } });
    throw e;
  }
}
