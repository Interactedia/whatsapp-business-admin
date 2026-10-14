import { prisma } from "@/lib/prisma";
import { phoneNumberConfig } from "@/lib/tenant/waba";
import { downloadInboundMedia, storeFromLink } from "./media";
import { resolveTemplateContents } from "./template-history";

type MediaMessage = {
  id: string; type: string; templateId: string | null; payload: unknown; text: string | null; waMessageId: string | null;
  mediaPath: string | null; mediaMime: string | null; mediaFilename: string | null;
  conversation?: { phoneNumber?: { id: string; metaPhoneNumberId: string; displayPhone: string | null; verifiedName: string | null; wabaAccount: { id: string; tenantId: string; metaWabaId: string; metaAppId: string | null; name: string | null; accessTokenEnc: string | null; appSecret: string | null; apiVersion: string } } | null };
};
const pending = new Map<string, Promise<MediaMessage>>();

/** Download only when viewed, so unavailable template media cannot block sending. */
export async function resolveTemplateMedia(message: MediaMessage): Promise<MediaMessage> {
  if (message.type !== "TEMPLATE" || message.mediaPath) return message;
  const existing = pending.get(message.id);
  if (existing) return existing;
  const task = (async () => {
    try {
      const contents = await resolveTemplateContents([message]);
      const media = contents.get(message.id)?.media;
      if (!media) return message;
      let stored: { path: string; mime: string } | null = null;
      if (media.link && /^https?:\/\//i.test(media.link)) stored = await storeFromLink(media.link);
      else if (/^\d+$/.test(media.id) && message.conversation?.phoneNumber) {
        stored = await downloadInboundMedia(media.id, phoneNumberConfig(message.conversation.phoneNumber));
      }
      if (!stored) return message;
      // Never serve remote HTML as an inline document from the app's origin.
      const supported = media.type === "image" ? /^image\/(jpeg|png|gif|webp|avif)$/i.test(stored.mime)
        : media.type === "video" ? stored.mime.startsWith("video/") : true;
      if (!supported) return message;
      return await prisma.message.update({
        where: { id: message.id },
        data: { mediaPath: stored.path, mediaMime: stored.mime, mediaFilename: media.filename || (media.type === "document" ? "document" : null) },
      });
    } catch {
      return message;
    }
  })();
  pending.set(message.id, task);
  try { return await task; } finally { pending.delete(message.id); }
}
