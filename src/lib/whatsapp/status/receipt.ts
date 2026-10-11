import { prisma } from "@/lib/prisma";
import { addOutboxEvent } from "@/lib/outbox";
import { createStatusReconciliationJobPayload } from "@/lib/queue";
import type { Prisma } from "@/generated/prisma/client";

type StatusPayload = {
  entry?: {
    changes?: {
      value?: {
        metadata?: { phone_number_id?: string };
        statuses?: { id?: string; status?: string }[];
      };
    }[];
  }[];
};

export class StatusReceiptError extends Error {
  constructor(message: string, public readonly code: "NO_STATUS" | "MIXED_PAYLOAD" | "MISSING_PHONE" | "UNKNOWN_PHONE" | "UNKNOWN_MESSAGE") {
    super(message);
    this.name = "StatusReceiptError";
  }
}

export interface StatusReceiptResult {
  webhookEventId: string;
  outboxEventIds: string[];
  tenantId: string;
  wabaAccountId: string;
  phoneNumberId: string;
  summary: string;
}

function statusChanges(payload: unknown) {
  const root = payload as StatusPayload;
  return (root.entry ?? []).flatMap((entry) =>
    (entry.changes ?? []).flatMap((change) => {
      const phone = change.value?.metadata?.phone_number_id;
      return (change.value?.statuses ?? []).map((status) => ({ phone, status }));
    })
  );
}

export async function persistStatusWebhookReceipt(input: {
  payload: unknown;
  signatureValid: boolean;
}): Promise<StatusReceiptResult> {
  const changes = statusChanges(input.payload).filter((change) => change.status.id && change.status.status);
  if (changes.length === 0) throw new StatusReceiptError("Webhook payload has no supported statuses", "NO_STATUS");

  const phoneIds = new Set(changes.map((change) => change.phone).filter(Boolean));
  if (phoneIds.size !== 1) throw new StatusReceiptError("Status webhook must reference exactly one business phone", "MISSING_PHONE");
  const metaPhoneNumberId = [...phoneIds][0]!;

  const phone = await prisma.phoneNumber.findFirst({
    where: { metaPhoneNumberId },
    include: { wabaAccount: true },
  });
  if (!phone) throw new StatusReceiptError("Status webhook references unknown phone", "UNKNOWN_PHONE");

  const messages = await prisma.message.findMany({
    where: {
      waMessageId: { in: changes.map((change) => change.status.id!) },
      tenantId: phone.wabaAccount.tenantId,
      conversation: { phoneNumberId: phone.id, tenantId: phone.wabaAccount.tenantId },
    },
    select: { id: true, waMessageId: true },
  });
  const byWaId = new Map(messages.map((message) => [message.waMessageId, message.id]));
  if (messages.length !== changes.length) throw new StatusReceiptError("Status webhook contains unknown message", "UNKNOWN_MESSAGE");

  return prisma.$transaction(async (tx) => {
    const event = await tx.webhookEvent.create({
      data: {
        payload: input.payload as Prisma.InputJsonValue,
        signatureValid: input.signatureValid,
        processedOk: false,
        eventSummary: "accepted durable status receipt",
      },
    });

    const outboxEventIds: string[] = [];
    for (const change of changes) {
      const waMessageId = change.status.id!;
      const outbox = await addOutboxEvent(tx, {
        tenantId: phone.wabaAccount.tenantId,
        payload: createStatusReconciliationJobPayload({
          tenantId: phone.wabaAccount.tenantId,
          wabaAccountId: phone.wabaAccount.id,
          phoneNumberId: phone.id,
          webhookEventId: event.id,
          messageId: byWaId.get(waMessageId)!,
          waMessageId,
          producer: "queue-producer",
          reason: "webhook-gap",
        }),
      });
      outboxEventIds.push(outbox.id);
    }

    return {
      webhookEventId: event.id,
      outboxEventIds,
      tenantId: phone.wabaAccount.tenantId,
      wabaAccountId: phone.wabaAccount.id,
      phoneNumberId: phone.id,
      summary: `accepted ${outboxEventIds.length} durable status event(s)`,
    };
  });
}
