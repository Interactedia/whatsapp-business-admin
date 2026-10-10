import { z } from "zod";
import { handle, ok, requireUser } from "@/lib/api";
import { ensureConversation } from "@/lib/whatsapp/send";

const startSchema = z.object({
  waId: z.string().trim().regex(/^\d{7,15}$/),
  name: z.string().trim().optional(),
});

/** Start (or resume) a conversation for a phone number. */
export const POST = handle(async (req) => {
  await requireUser();
  const body = startSchema.parse(await req.json());
  const { conversation, contact } = await ensureConversation(body.waId, body.name);
  return ok({ id: conversation.id, contactId: contact.id }, 201);
});
