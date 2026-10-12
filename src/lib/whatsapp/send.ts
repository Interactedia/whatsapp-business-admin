import { prisma } from "@/lib/prisma";
import type { WabaConfig } from "@/lib/settings";
import { graphFetch, WhatsAppApiError } from "@/lib/whatsapp/client";
import { phoneNumberConfig, type OwnedPhoneNumber } from "@/lib/tenant/waba";
import { publish } from "@/server/realtime";
import { addCanonicalEvent, type ExternalMessageType } from "@/lib/events";
import { buildOutboundMessageAcceptedEvent } from "@/lib/events/producers";
import { serializeMessage } from "@/lib/whatsapp/webhook";
import type { MessageType, Prisma } from "@/generated/prisma/client";
import { buildTemplateContent, templateContentText, templateContentPreview } from "./template-content";
import { addOutboxEvent } from "@/lib/outbox";
import { createOutboundMessageJobPayload } from "@/lib/queue";
import type { KnownJobPayload } from "@/lib/queue";

export { isWithinSessionWindow } from "@/lib/whatsapp/window";

function externalMessageType(type: MessageType): ExternalMessageType {
  if (type === "UNSUPPORTED") return "TEXT";
  return type;
}

/** Get or create the tenant-scoped contact + phone-scoped conversation for a wa_id. */
export async function ensureConversation(
  waId: string,
  name?: string,
  senderPhone?: Pick<OwnedPhoneNumber, "id" | "wabaAccount">
) {
  if (senderPhone) {
    const tenantId = senderPhone.wabaAccount.tenantId;
    const contact = await prisma.contact.upsert({
      where: { tenantId_waId: { tenantId, waId } },
      update: name ? { name } : {},
      create: { waId, name, tenantId },
    });
    const existingConversation = await prisma.conversation.findFirst({
      where: { tenantId, contactId: contact.id, phoneNumberId: senderPhone.id },
    });
    const conversation = existingConversation ?? await prisma.conversation.create({
      data: { tenantId, contactId: contact.id, phoneNumberId: senderPhone.id },
    });
    return { contact, conversation };
  }

  // Backwards-compatible path: resolve phone number or fallback to existing record
  const existingContact = await prisma.contact.findFirst({ where: { waId } });
  const tenantId = existingContact?.tenantId ?? undefined;
  const contact = existingContact
    ? (name ? await prisma.contact.update({ where: { id: existingContact.id }, data: { name } }) : existingContact)
    : await prisma.contact.create({ data: { waId, name: name ?? null, tenantId } });

  const existingConversation = await prisma.conversation.findFirst({ where: { contactId: contact.id } });
  const conversation = existingConversation ?? await prisma.conversation.create({
    data: { contactId: contact.id, tenantId },
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
  | { kind: "template"; templateId?: string; templateName: string; language: string; components?: unknown[]; templateComponents?: unknown; preview?: string }
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
export async function resolveConversationSenderConfig(conversationId: string): Promise<WabaConfig> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { phoneNumber: { include: { wabaAccount: true } } },
  });
  if (!conversation?.phoneNumber) throw new WhatsAppApiError(403, "Conversation has no authorized sender phone number.");
  return phoneNumberConfig(conversation.phoneNumber);
}

export async function sendMessage(opts: {
  conversationId: string;
  to: string;
  content: OutboundContent;
  sentById?: string;
  config?: WabaConfig;
  /** External idempotency binding (POST /api/v1/messages). */
  idempotencyKey?: string;
  idempotencyFingerprint?: string;
}) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: opts.conversationId },
    include: { phoneNumber: { include: { wabaAccount: true } } },
  });
  if (!conversation) throw new WhatsAppApiError(404, "Conversation not found.");
  if (!conversation.phoneNumber) throw new WhatsAppApiError(403, "Conversation has no authorized sender phone number.");
  const cfg = opts.config ?? phoneNumberConfig(conversation.phoneNumber);
  if (!cfg.phoneNumberId) throw new WhatsAppApiError(400, "WhatsApp is not connected.");

  let templateContent;
  if (opts.content.kind === "template") {
    const content = opts.content;
    const definition = content.templateComponents ?? (await prisma.template.findUnique({
      where: content.templateId ? { id: content.templateId } : { name_language: { name: content.templateName, language: content.language } },
      select: { components: true },
    }))?.components;
    templateContent = buildTemplateContent({ name: content.templateName, language: content.language, definition, parameters: content.components });
  }
  const preview = templateContent ? templateContentPreview(templateContent) : (previewFor(opts.content) ?? "");

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
      tenantId: conversation.tenantId,
      conversationId: opts.conversationId,
      direction: "OUT",
      type,
      status: "PENDING",
      text: templateContent ? templateContentText(templateContent) : opts.content.kind === "text" ? (opts.content.text ?? "") : preview,
      caption: opts.content.kind === "media" ? opts.content.caption : undefined,
      mediaPath: opts.content.kind === "media" ? opts.content.mediaPath : undefined,
      mediaMime: opts.content.kind === "media" ? opts.content.mediaMime : undefined,
      mediaFilename: opts.content.kind === "media" ? opts.content.filename : undefined,
      templateId: opts.content.kind === "template" ? opts.content.templateId : undefined,
      payload: templateContent ? { templateContent } : opts.content.kind === "flow" ? { flowId: opts.content.flowId, cta: opts.content.cta } : undefined,
      sentById: opts.sentById,
      idempotencyKey: opts.idempotencyKey,
      idempotencyFingerprint: opts.idempotencyFingerprint,
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
      data: { lastMessageAt: new Date(), lastPreview: preview.slice(0, 140) },
    });
    publish({ type: "message:new", payload: { conversationId: opts.conversationId, message: serializeMessage(updated) } }, conversation.tenantId);
    return updated;
  } catch (e) {
    const failed = await prisma.message.update({
      where: { id: message.id },
      data: { status: "FAILED", errorJson: { message: e instanceof Error ? e.message : String(e) } },
    });
    publish({ type: "message:new", payload: { conversationId: opts.conversationId, message: serializeMessage(failed) } }, conversation.tenantId);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Durable outbound via transactional outbox
// ---------------------------------------------------------------------------

export interface EnqueueOutboundMessageOptions {
  conversationId: string;
  to: string;
  content: OutboundContent;
  sentById?: string;
  config?: WabaConfig;
  /** External idempotency binding (POST /api/v1/messages). */
  idempotencyKey?: string;
  idempotencyFingerprint?: string;
}

/**
 * Durable message send using the transactional outbox pattern.
 *
 * Atomically creates a Message row (PENDING) and an OutboxEvent in PostgreSQL.
 * The OutboxDispatcher picks up the event and enqueues it to BullMQ. The
 * outbound worker calls Meta, updates the Message row, and notifies via
 * realtime.
 *
 * Returns immediately with the PENDING message. Use `enqueueOutboundMessage`
 * when the caller does not need to wait for Meta confirmation (e.g. API
 * clients that poll or subscribe to realtime events).
 *
 * For "uncertain" Meta responses (timeout, 5xx, rate limit, parse error),
 * the message stays PENDING so an operator can review it without triggering
 * a BullMQ retry that might cause a duplicate send.
 */
export async function enqueueOutboundMessage(
  opts: EnqueueOutboundMessageOptions
): Promise<{ id: string; status: "PENDING"; waMessageId: null }> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: opts.conversationId },
    include: { phoneNumber: { include: { wabaAccount: true } } },
  });
  if (!conversation) throw new WhatsAppApiError(404, "Conversation not found.");
  if (!conversation.phoneNumber) throw new WhatsAppApiError(403, "Conversation has no authorized sender phone number.");
  const cfg = opts.config ?? phoneNumberConfig(conversation.phoneNumber);
  if (!cfg.phoneNumberId) throw new WhatsAppApiError(400, "WhatsApp is not connected.");
  // Extract IDs while phoneNumber narrowing is still active
  const phoneNumberId: string = conversation.phoneNumber.id;
  const wabaAccountId: string = conversation.phoneNumber.wabaAccount.id;
  const tenantId: string = conversation.tenantId ?? "";

  let templateContent: ReturnType<typeof buildTemplateContent> | null = null;
  if (opts.content.kind === "template") {
    const content = opts.content;
    const definition = content.templateComponents ?? (await prisma.template.findUnique({
      where: content.templateId ? { id: content.templateId } : { name_language: { name: content.templateName, language: content.language } },
      select: { components: true },
    }))?.components;
    templateContent = buildTemplateContent({ name: content.templateName, language: content.language, definition, parameters: content.components });
  }
  const preview = templateContent ? templateContentPreview(templateContent) : (previewFor(opts.content) ?? "");

  const type: MessageType =
    opts.content.kind === "text"
      ? "TEXT"
      : opts.content.kind === "template"
        ? "TEMPLATE"
        : opts.content.kind === "flow"
          ? "INTERACTIVE"
        : MEDIA_TYPE_TO_ENUM[opts.content.mediaType];

  // Build payload stored in Message row for the worker to reconstruct the API call.
  // For templates: store the components that were validated and sent so the worker
  // can reconstruct the Meta payload without needing the original caller's data.
  // For flows: we store the flowId/cta/token.
  const storedPayload: Record<string, unknown> =
    templateContent
      ? (() => {
          const tc = opts.content as Extract<OutboundContent, { kind: "template" }>;
          return {
            _kind: "template",
            name: tc.templateName,
            language: tc.language,
            components: tc.components ?? [],
          };
        })()
      : opts.content.kind === "flow"
        ? { flowId: opts.content.flowId, cta: opts.content.cta, flowToken: opts.content.flowToken }
        : {};

  // Atomic: Message row + OutboxEvent in one transaction
  const messageId = await prisma.$transaction(async (tx) => {
    // Create the PENDING message
    const message = await tx.message.create({
      data: {
        tenantId: conversation.tenantId,
        conversationId: opts.conversationId,
        direction: "OUT",
        type,
        status: "PENDING",
        text: templateContent ? templateContentText(templateContent) : opts.content.kind === "text" ? (opts.content.text ?? "") : preview,
        caption: opts.content.kind === "media" ? opts.content.caption : undefined,
        mediaPath: opts.content.kind === "media" ? opts.content.mediaPath : undefined,
        mediaMime: opts.content.kind === "media" ? opts.content.mediaMime : undefined,
        mediaFilename: opts.content.kind === "media" ? (opts.content.filename ?? null) : undefined,
        templateId: opts.content.kind === "template" ? opts.content.templateId : undefined,
        payload: Object.keys(storedPayload).length > 0 ? (storedPayload as unknown as Prisma.InputJsonValue) : undefined,
        sentById: opts.sentById,
        idempotencyKey: opts.idempotencyKey,
        idempotencyFingerprint: opts.idempotencyFingerprint,
      },
    });

    // Add the ERA 2 outbox event so the dispatcher enqueues it to BullMQ.
    await addOutboxEvent(tx, {
      tenantId,
      payload: createOutboundMessageJobPayload({
        tenantId,
        wabaAccountId,
        phoneNumberId,
        conversationId: opts.conversationId,
        messageId: message.id,
        producer: "queue-producer",
      }) as KnownJobPayload,
    });

    await addCanonicalEvent(tx, buildOutboundMessageAcceptedEvent({
      tenantId,
      conversationId: opts.conversationId,
      contactId: conversation.contactId,
      phoneNumberId,
      wabaAccountId,
      messageId: message.id,
      type: externalMessageType(type),
      occurredAt: message.timestamp,
    }));

    return message.id;
  });

  return { id: messageId, status: "PENDING" as const, waMessageId: null };
}
