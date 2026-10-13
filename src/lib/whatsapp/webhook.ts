import { prisma } from "@/lib/prisma";
import { addCanonicalEvent, isValidProviderId, type ExternalMessageType } from "@/lib/events";
import { isIdempotencyUniqueViolation } from "@/lib/idempotency";
import { buildConversationChangedEvent, buildConversationStatusChangedEvent, buildInboundMessageReceivedEvent, buildOutboundMessageStatusChangedEvent } from "@/lib/events/producers";
import { getWabaConfig } from "@/lib/settings";
import { phoneNumberConfig, resolveInboundPhoneNumber } from "@/lib/tenant/waba";
import { downloadInboundMedia } from "@/lib/whatsapp/media";
import { publish, publishGlobal } from "@/server/realtime";
import type { MessageStatus, MessageType, TemplateStatus } from "@/generated/prisma/client";
import { recordFlowSubmission, redactFlowWebhookPayload } from "@/lib/whatsapp/flow-submission";
import { readTemplateContent, templateContentText } from "@/lib/whatsapp/template-content";
import type { ImageEnrichmentResult } from "@/lib/whatsapp/image-enrichment";
import { enrichImage } from "@/lib/whatsapp/image-enrichment-service";
import { createImageInterpreter } from "@/lib/ai/image-interpreter";

export { verifySignature } from "@/lib/whatsapp/signature";

// ---- payload shapes (partial) ----
type WaMessage = {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; caption?: string; mime_type?: string };
  video?: { id: string; caption?: string; mime_type?: string };
  audio?: { id: string; mime_type?: string };
  document?: { id: string; caption?: string; filename?: string; mime_type?: string };
  sticker?: { id: string; mime_type?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  button?: { text: string; payload: string };
  interactive?: {
    type: string;
    button_reply?: { title: string };
    list_reply?: { title: string };
    nfm_reply?: { name?: string; body?: string; response_json?: string };
  };
  reaction?: { emoji: string; message_id: string };
  errors?: unknown[];
};

type WaStatus = {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
  errors?: { code: number; title: string; message?: string }[];
};

type WebhookValue = {
  metadata?: { phone_number_id: string };
  contacts?: { wa_id: string; profile?: { name?: string } }[];
  messages?: WaMessage[];
  statuses?: WaStatus[];
  // template status update
  message_template_id?: number | string;
  message_template_name?: string;
  message_template_language?: string;
  event?: string;
  reason?: string;
};

const MEDIA_TYPES = ["image", "video", "audio", "document", "sticker"];

function mapMessageType(t: string): MessageType {
  const upper = t.toUpperCase();
  const known: MessageType[] = [
    "TEXT", "IMAGE", "VIDEO", "AUDIO", "DOCUMENT", "STICKER", "LOCATION",
    "CONTACTS", "TEMPLATE", "INTERACTIVE", "BUTTON", "REACTION",
  ];
  return (known.includes(upper as MessageType) ? upper : "UNSUPPORTED") as MessageType;
}

function externalMessageType(type: MessageType): ExternalMessageType {
  if (type === "UNSUPPORTED") return "TEXT";
  return type;
}

function summarizeText(m: WaMessage): string {
  switch (m.type) {
    case "text": return m.text?.body ?? "";
    case "image": return m.image?.caption ?? "📷 Photo";
    case "video": return m.video?.caption ?? "🎥 Video";
    case "audio": return "🎧 Audio";
    case "document": return m.document?.caption ?? `📄 ${m.document?.filename ?? "Document"}`;
    case "sticker": return "🌟 Sticker";
    case "location": return `📍 ${m.location?.name ?? "Location"}`;
    case "interactive": return m.interactive?.nfm_reply?.body ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "Reply";
    case "button": return m.button?.text ?? "Reply";
    case "reaction": return `${m.reaction?.emoji ?? "❤️"}`;
    default: return "Message";
  }
}

const STATUS_MAP: Record<string, MessageStatus> = {
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
};

const TEMPLATE_EVENT_MAP: Record<string, TemplateStatus> = {
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  PAUSED: "PAUSED",
  DISABLED: "DISABLED",
  FLAGGED: "PAUSED",
};

/** Process a full webhook payload. Returns a short human summary for the log. */
export async function processWebhook(payload: unknown): Promise<string> {
  const config = await getWabaConfig();
  const root = payload as { entry?: { changes?: { field?: string; value?: WebhookValue }[] }[] };
  const summaries: string[] = [];

  for (const entry of root.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;

      if (change.field === "message_template_status_update" || value.event) {
        summaries.push(await handleTemplateStatus(value));
        continue;
      }

      // Inbound messages
      const profileName = value.contacts?.[0]?.profile?.name;
      for (const msg of value.messages ?? []) {
        summaries.push(await handleInboundMessage(msg, profileName, value.metadata?.phone_number_id, config));
      }
      // Delivery statuses
      for (const st of value.statuses ?? []) {
        summaries.push(await handleStatus(st, value.metadata?.phone_number_id));
      }
    }
  }

  return summaries.filter(Boolean).join("; ") || "no actionable events";
}

async function handleInboundMessage(
  msg: WaMessage,
  profileName: string | undefined,
  metaPhoneNumberId: string | undefined,
  fallbackConfig: Awaited<ReturnType<typeof getWabaConfig>>,
): Promise<string> {
  if (!metaPhoneNumberId) throw new Error("Inbound webhook missing business phone metadata");
  const businessPhone = await resolveInboundPhoneNumber(metaPhoneNumberId);
  const config = phoneNumberConfig(businessPhone);
  const waId = msg.from;
  const ts = new Date(Number(msg.timestamp) * 1000);

  const tenantId = businessPhone.wabaAccount.tenantId;

  // ---- validation gate: nothing below may mutate until all of it passes ----
  // A rejected event must not leave behind a Contact, Conversation or Message.
  // Provider id is checked against the same charset the canonical-event
  // validator enforces, so a malformed wamid fails here rather than deep
  // inside the transaction after rows were already written.
  if (!waId) throw new Error("Inbound webhook message missing sender id");
  if (!isValidProviderId(msg.id)) throw new Error("Inbound webhook message has a malformed provider message id");
  if (Number.isNaN(ts.getTime())) throw new Error("Inbound webhook message has an invalid timestamp");

  const preview = summarizeText(msg);
  void fallbackConfig;

  // Media download for supported types.
  let mediaPath: string | null = null;
  let mediaMime: string | null = null;
  let mediaFilename: string | null = null;
  let caption: string | null = null;

  if (MEDIA_TYPES.includes(msg.type)) {
    const mediaObj = (msg as unknown as Record<string, { id: string; caption?: string; filename?: string }>)[msg.type];
    caption = mediaObj?.caption ?? null;
    mediaFilename = mediaObj?.filename ?? null;
    if (mediaObj?.id) {
      try {
        const dl = await downloadInboundMedia(mediaObj.id, config);
        if (dl) {
          mediaPath = dl.path;
          mediaMime = dl.mime;
        }
      } catch (e) {
        console.error("Media download failed:", e);
      }
    }
  }

  // Idempotency: skip if we already stored this wamid.
  if (msg.type === "interactive" && msg.interactive?.type === "nfm_reply" && msg.interactive.nfm_reply?.response_json) {
    await recordFlowSubmission({ waMessageId: msg.id, responseJson: msg.interactive.nfm_reply.response_json }).catch((error) => {
      console.warn("Could not associate WhatsApp Flow completion:", error instanceof Error ? error.message : error);
    });
  }
  const existing = await prisma.message.findUnique({ where: { waMessageId: msg.id } });
  if (existing) return `dup ${msg.id}`;

  // Contact creation lives INSIDE the transaction: if the conversation, the
  // message, or any canonical event is rejected, the contact rolls back with
  // them. Keeping it outside used to orphan contacts on validation failure.
  let committed;
  try {
    committed = await prisma.$transaction(async (tx) => {
    const contact = await tx.contact.upsert({
      where: { tenantId_waId: { tenantId, waId } },
      update: { profileName: profileName ?? undefined, lastInboundAt: ts },
      create: { waId, profileName, lastInboundAt: ts, tenantId },
    });
    if (contact.tenantId !== tenantId) throw new Error("Inbound contact tenant mismatch");

    const existingByContact = await tx.conversation.findFirst({ where: { contactId: contact.id } });
    if (existingByContact?.phoneNumberId && existingByContact.phoneNumberId !== businessPhone.id) {
      throw new Error("Inbound conversation sender mismatch");
    }
    if (existingByContact && !existingByContact.phoneNumberId) {
      throw new Error("Inbound conversation is unbound");
    }
    const existingConversation = (await tx.conversation.findFirst({
      where: { tenantId, contactId: contact.id, phoneNumberId: businessPhone.id },
    })) ?? existingByContact;
    const previousStatus = existingConversation?.status ?? null;
    const conversation = existingConversation
      ? await tx.conversation.update({
          where: { id: existingConversation.id },
          data: {
            lastMessageAt: ts,
            lastInboundAt: ts,
            lastPreview: preview.slice(0, 140),
            unreadCount: { increment: 1 },
            status: "OPEN",
          },
        })
      : await tx.conversation.create({
          data: {
            contactId: contact.id,
            tenantId,
            phoneNumberId: businessPhone.id,
            lastMessageAt: ts,
            lastInboundAt: ts,
            lastPreview: preview.slice(0, 140),
            unreadCount: 1,
          },
        });

    const created = await tx.message.create({
      data: {
        tenantId: businessPhone.wabaAccount.tenantId,
        conversationId: conversation.id,
        direction: "IN",
        type: mapMessageType(msg.type),
        status: "RECEIVED",
        waMessageId: msg.id,
        text: msg.type === "text" ? msg.text?.body : summarizeText(msg),
        caption,
        mediaPath,
        mediaMime,
        mediaFilename,
        payload: redactFlowWebhookPayload(msg) as object,
        timestamp: ts,
      },
    });

    await addCanonicalEvent(tx, buildInboundMessageReceivedEvent({
      tenantId,
      conversationId: conversation.id,
      contactId: contact.id,
      phoneNumberId: businessPhone.id,
      wabaAccountId: businessPhone.wabaAccount.id,
      messageId: created.id,
      providerMessageId: msg.id,
      type: externalMessageType(created.type),
      preview,
      occurredAt: ts,
    }));
    const conversationEvent = existingConversation
      ? buildConversationStatusChangedEvent({
          tenantId,
          conversationId: conversation.id,
          contactId: contact.id,
          phoneNumberId: businessPhone.id,
          wabaAccountId: businessPhone.wabaAccount.id,
          previousStatus,
          status: conversation.status,
          occurredAt: ts,
        })
      : buildConversationChangedEvent({
          tenantId,
          conversationId: conversation.id,
          contactId: contact.id,
          phoneNumberId: businessPhone.id,
          wabaAccountId: businessPhone.wabaAccount.id,
          kind: "CREATED",
          status: conversation.status,
          occurredAt: ts,
        });
    if (conversationEvent) await addCanonicalEvent(tx, conversationEvent);

    return { contact, conversation, created };
  });
  } catch (error) {
    // Two deliveries of the same wamid raced past the pre-check above and one
    // won the unique index. The winner already persisted everything, so this
    // delivery is idempotently a duplicate — not a processing failure.
    if (isIdempotencyUniqueViolation(error)) {
      const winner = await prisma.message.findUnique({ where: { waMessageId: msg.id } });
      if (winner) return `dup ${msg.id}`;
    }
    throw error;
  }
  const { contact, conversation, created } = committed;

  // Published only after the transaction committed: a rolled-back message
  // must never be announced to realtime clients as new.
  publish({
    type: "message:new",
    payload: { conversationId: conversation.id, contactId: contact.id, message: serializeMessage(created) },
  }, businessPhone.wabaAccount.tenantId);

  // ---- image enrichment (fire-and-forget, bounded timeout) ----
  // Triggers asynchronous visual interpretation after the message is stored.
  // Never blocks turn completion; never reorders conversation events.
  if (msg.type === "image" && mediaPath) {
    const interpreter = createImageInterpreter();
    const dedupKey = `${conversation.id}:${msg.id}`;
    const enrichPayload = redactFlowWebhookPayload(msg) as object;

    enrichImage(
      { mediaId: msg.id, dedupKey },
      interpreter,
      { accessToken: config.accessToken ?? "", apiVersion: config.apiVersion },
    )
      .then(async (result: ImageEnrichmentResult) => {
        try {
          const updatedPayload = { ...enrichPayload, imageEnrichment: result };
          await prisma.message.update({
            where: { id: created.id },
            data: { payload: updatedPayload as object },
          });

          // Publish enrichment result — clients can use this to display the description.
          publish({
            type: "message:image-enriched",
            payload: {
              messageId: created.id,
              conversationId: conversation.id,
              enrichment: serializeEnrichmentResult(result),
            },
          }, businessPhone.wabaAccount.tenantId);
        } catch (e) {
          console.error("Failed to persist image enrichment result:", e);
        }
      })
      .catch((e) => {
        console.error("Image enrichment threw unexpectedly:", e);
      });
  }

  return `message from ${waId}`;
}

async function handleStatus(st: WaStatus, metaPhoneNumberId?: string): Promise<string> {
  if (!metaPhoneNumberId) throw new Error("Status webhook missing business phone metadata");
  const businessPhone = await resolveInboundPhoneNumber(metaPhoneNumberId);

  const status = STATUS_MAP[st.status];
  if (!status) return "";
  const errorJson = st.errors && st.errors.length > 0 ? (st.errors as object) : undefined;

  // Only downgrade never (read > delivered > sent); simplest: update if message exists.
  const msg = await prisma.message.findUnique({
    where: { waMessageId: st.id },
    include: { conversation: { select: { phoneNumberId: true } } },
  });
  if (msg) {
    if (msg.tenantId !== businessPhone.wabaAccount.tenantId) throw new Error("Status tenant mismatch");
    if (msg.status !== status) {
      await prisma.$transaction(async (tx) => {
        await tx.message.update({
          where: { id: msg.id },
          data: { status, errorJson: errorJson ?? undefined },
        });
        await addCanonicalEvent(tx, buildOutboundMessageStatusChangedEvent({
          tenantId: msg.tenantId!,
          conversationId: msg.conversationId,
          messageId: msg.id,
          phoneNumberId: msg.conversation.phoneNumberId ?? businessPhone.id,
          wabaAccountId: businessPhone.wabaAccount.id,
          providerMessageId: st.id,
          previousStatus: msg.status,
          status,
          occurredAt: new Date(Number(st.timestamp) * 1000),
        }));
      });
    }
    publish({ type: "message:status", payload: { conversationId: msg.conversationId, waMessageId: st.id, status } }, msg.tenantId);
  }

  // Broadcast recipient tracking.
  const recipient = await prisma.broadcastRecipient.findUnique({ where: { waMessageId: st.id }, include: { contact: true } });
  if (recipient) {
    if (recipient.contact.tenantId !== businessPhone.wabaAccount.tenantId) throw new Error("Status broadcast tenant mismatch");
    const recStatus = status === "FAILED" ? "FAILED" : status === "SENT" ? "SENT" : status === "DELIVERED" ? "DELIVERED" : "READ";
    await prisma.broadcastRecipient.update({
      where: { id: recipient.id },
      data: { status: recStatus, error: st.errors?.[0]?.message ?? st.errors?.[0]?.title },
    });
  }

  return `status ${st.status}`;
}

async function handleTemplateStatus(value: WebhookValue): Promise<string> {
  const event = (value.event || "").toUpperCase();
  const status = TEMPLATE_EVENT_MAP[event];
  if (!status) return "";

  const metaId = value.message_template_id ? String(value.message_template_id) : null;
  const where = metaId
    ? { metaTemplateId: metaId }
    : value.message_template_name && value.message_template_language
      ? { name_language: { name: value.message_template_name, language: value.message_template_language } }
      : null;
  if (!where) return "";

  const tmpl = await prisma.template.findFirst({
    where: metaId ? { metaTemplateId: metaId } : (where as { name_language: { name: string; language: string } }).name_language,
  });
  if (tmpl) {
    await prisma.template.update({
      where: { id: tmpl.id },
      data: { status, rejectionReason: status === "REJECTED" ? value.reason ?? "Rejected" : null },
    });
    // Template is a global (non tenant-owned) surface; payload carries only template id/status.
    publishGlobal({ type: "template:status", payload: { id: tmpl.id, status } });
  }
  return `template ${event}`;
}

/**
 * Serialize an image-enrichment result for safe WebSocket emission.
 * Never exposes raw image bytes, tokens, or raw provider responses.
 */
function serializeEnrichmentResult(result: ImageEnrichmentResult) {
  if (result.ok) {
    return {
      status: result.status,
      description: {
        content: result.description.content,
        mediaRef: result.description.mediaRef,
        provenance: result.description.provenance,
        provider: result.description.provider,
        model: result.description.model,
      },
    };
  }
  return { status: result.status, failure: result.failure };
}

/** Serialize a Prisma message to a plain object safe for JSON/WS. */
export function serializeMessage(m: {
  id: string;
  conversationId: string;
  direction: string;
  type: string;
  status: string;
  text: string | null;
  caption: string | null;
  mediaPath: string | null;
  mediaMime: string | null;
  mediaFilename: string | null;
  timestamp: Date;
  waMessageId?: string | null;
  payload?: unknown;
}) {
  const templateContent = m.type === "TEMPLATE" ? readTemplateContent(m.payload) : null;
  return {
    id: m.id,
    conversationId: m.conversationId,
    direction: m.direction,
    type: m.type,
    status: m.status,
    text: templateContent ? templateContentText(templateContent) : m.text,
    ...(templateContent ? { templateContent } : {}),
    caption: m.caption,
    hasMedia: Boolean(m.mediaPath),
    mediaMime: m.mediaMime,
    mediaFilename: m.mediaFilename,
    timestamp: m.timestamp.toISOString(),
    waMessageId: m.waMessageId ?? null,
  };
}
