import { prisma } from "@/lib/prisma";
import { getWabaConfig } from "@/lib/settings";
import { downloadInboundMedia } from "@/lib/whatsapp/media";
import { publish } from "@/server/realtime";
import type { MessageStatus, MessageType, TemplateStatus } from "@/generated/prisma/client";
import { recordFlowSubmission, redactFlowWebhookPayload } from "@/lib/whatsapp/flow-submission";

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
        summaries.push(await handleInboundMessage(msg, profileName, config));
      }
      // Delivery statuses
      for (const st of value.statuses ?? []) {
        summaries.push(await handleStatus(st));
      }
    }
  }

  return summaries.filter(Boolean).join("; ") || "no actionable events";
}

async function handleInboundMessage(
  msg: WaMessage,
  profileName: string | undefined,
  config: Awaited<ReturnType<typeof getWabaConfig>>,
): Promise<string> {
  const waId = msg.from;
  const ts = new Date(Number(msg.timestamp) * 1000);

  // Upsert contact.
  const contact = await prisma.contact.upsert({
    where: { waId },
    update: { profileName: profileName ?? undefined, lastInboundAt: ts },
    create: { waId, profileName, lastInboundAt: ts },
  });

  // Upsert conversation.
  const preview = summarizeText(msg);
  const conversation = await prisma.conversation.upsert({
    where: { contactId: contact.id },
    update: {
      lastMessageAt: ts,
      lastInboundAt: ts,
      lastPreview: preview.slice(0, 140),
      unreadCount: { increment: 1 },
      status: "OPEN",
    },
    create: {
      contactId: contact.id,
      lastMessageAt: ts,
      lastInboundAt: ts,
      lastPreview: preview.slice(0, 140),
      unreadCount: 1,
    },
  });

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

  const created = await prisma.message.create({
    data: {
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

  publish({
    type: "message:new",
    payload: { conversationId: conversation.id, contactId: contact.id, message: serializeMessage(created) },
  });

  return `message from ${waId}`;
}

async function handleStatus(st: WaStatus): Promise<string> {
  const status = STATUS_MAP[st.status];
  if (!status) return "";
  const errorJson = st.errors && st.errors.length > 0 ? (st.errors as object) : undefined;

  // Only downgrade never (read > delivered > sent); simplest: update if message exists.
  const msg = await prisma.message.findUnique({ where: { waMessageId: st.id } });
  if (msg) {
    await prisma.message.update({
      where: { id: msg.id },
      data: { status, errorJson: errorJson ?? undefined },
    });
    publish({ type: "message:status", payload: { conversationId: msg.conversationId, waMessageId: st.id, status } });
  }

  // Broadcast recipient tracking.
  const recipient = await prisma.broadcastRecipient.findUnique({ where: { waMessageId: st.id } });
  if (recipient) {
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
    publish({ type: "template:status", payload: { id: tmpl.id, status } });
  }
  return `template ${event}`;
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
}) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    direction: m.direction,
    type: m.type,
    status: m.status,
    text: m.text,
    caption: m.caption,
    hasMedia: Boolean(m.mediaPath),
    mediaMime: m.mediaMime,
    mediaFilename: m.mediaFilename,
    timestamp: m.timestamp.toISOString(),
    waMessageId: m.waMessageId ?? null,
  };
}
