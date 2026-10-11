import { prisma } from "@/lib/prisma";
import { addOutboxEvent } from "@/lib/outbox";
import { createInboundWebhookJobPayload } from "@/lib/queue";
import type { Prisma } from "@/generated/prisma/client";
import { classifyWebhookPayload } from "./classify";

export class InboundReceiptError extends Error {
  constructor(message: string, public readonly code: "NO_INBOUND_MESSAGE" | "MISSING_PHONE" | "UNKNOWN_PHONE" | "MULTIPLE_PHONES") {
    super(message);
    this.name = "InboundReceiptError";
  }
}

export interface InboundReceiptResult {
  webhookEventId: string;
  outboxEventId: string;
  tenantId: string;
  wabaAccountId: string;
  phoneNumberId: string;
  summary: string;
}

function inboundPhoneNumberIds(payload: unknown): string[] {
  const root = payload as { entry?: { changes?: { value?: { metadata?: { phone_number_id?: string }; messages?: unknown[] } }[] }[] };
  const ids = new Set<string>();
  for (const entry of root.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if ((change.value?.messages?.length ?? 0) > 0 && change.value?.metadata?.phone_number_id) {
        ids.add(change.value.metadata.phone_number_id);
      }
    }
  }
  return [...ids];
}

export async function persistInboundWebhookReceipt(input: {
  payload: unknown;
  signatureValid: boolean;
}): Promise<InboundReceiptResult> {
  const classification = classifyWebhookPayload(input.payload);
  if (!classification.hasInboundMessages) {
    throw new InboundReceiptError("Webhook payload has no inbound messages", "NO_INBOUND_MESSAGE");
  }

  const phoneIds = inboundPhoneNumberIds(input.payload);
  if (phoneIds.length === 0) {
    throw new InboundReceiptError("Inbound webhook missing business phone metadata", "MISSING_PHONE");
  }
  if (phoneIds.length > 1) {
    throw new InboundReceiptError("Inbound webhook spans multiple business phone numbers", "MULTIPLE_PHONES");
  }
  const metaPhoneNumberId = phoneIds[0];

  return prisma.$transaction(async (tx) => {
    const phone = await tx.phoneNumber.findFirst({
      where: { metaPhoneNumberId },
      include: { wabaAccount: true },
    });
    if (!phone) throw new InboundReceiptError("Inbound webhook references an unknown phone number", "UNKNOWN_PHONE");

    const event = await tx.webhookEvent.create({
      data: {
        payload: input.payload as Prisma.InputJsonValue,
        signatureValid: input.signatureValid,
        processedOk: false,
        eventSummary: "accepted durable inbound receipt",
      },
    });

    const outbox = await addOutboxEvent(tx, {
      tenantId: phone.wabaAccount.tenantId,
      payload: createInboundWebhookJobPayload({
        tenantId: phone.wabaAccount.tenantId,
        wabaAccountId: phone.wabaAccountId,
        phoneNumberId: phone.id,
        webhookEventId: event.id,
        source: "meta-webhook",
      }),
    });

    return {
      webhookEventId: event.id,
      outboxEventId: outbox.id,
      tenantId: phone.wabaAccount.tenantId,
      wabaAccountId: phone.wabaAccountId,
      phoneNumberId: phone.id,
      summary: `accepted durable inbound receipt ${event.id}`,
    };
  });
}
