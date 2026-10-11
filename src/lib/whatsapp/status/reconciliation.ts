import { prisma } from "@/lib/prisma";
import { Prisma, type MessageStatus } from "@/generated/prisma/client";

const STATUS_MAP: Record<string, MessageStatus> = {
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
};

const STATUS_RANK: Record<MessageStatus, number> = {
  PENDING: 0,
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
  FAILED: 1,
  RECEIVED: 3,
};

type StatusPayload = {
  entry?: {
    changes?: {
      value?: {
        metadata?: { phone_number_id?: string };
        statuses?: { id?: string; status?: string; errors?: { code?: number; title?: string; message?: string }[] }[];
      };
    }[];
  }[];
};

export interface StatusReconciliationResult {
  messageId: string;
  waMessageId: string;
  status: MessageStatus;
  changed: boolean;
  summary: string;
}

function statusesFor(payload: unknown, waMessageId: string) {
  const root = payload as StatusPayload;
  return (root.entry ?? []).flatMap((entry) =>
    (entry.changes ?? []).flatMap((change) =>
      (change.value?.statuses ?? [])
        .filter((status) => status.id === waMessageId)
        .map((status) => ({ phoneNumberId: change.value?.metadata?.phone_number_id, status }))
    )
  );
}

function nextStatus(current: MessageStatus, incoming: MessageStatus): MessageStatus {
  if (incoming === "FAILED" && STATUS_RANK[current] > STATUS_RANK.SENT) return current;
  return STATUS_RANK[incoming] >= STATUS_RANK[current] ? incoming : current;
}

export async function reconcileStatusEvent(input: {
  webhookEventId?: string;
  tenantId: string;
  wabaAccountId: string;
  phoneNumberId: string;
  messageId: string;
  waMessageId: string;
}): Promise<StatusReconciliationResult> {
  return prisma.$transaction(async (tx) => {
    const message = await tx.message.findFirst({
      where: {
        id: input.messageId,
        waMessageId: input.waMessageId,
        tenantId: input.tenantId,
        conversation: {
          tenantId: input.tenantId,
          phoneNumberId: input.phoneNumberId,
          phoneNumber: { wabaAccountId: input.wabaAccountId },
        },
      },
      select: { id: true, status: true, conversationId: true, waMessageId: true },
    });
    if (!message?.waMessageId) throw new Error("Status message ownership/correlation check failed");

    const event = input.webhookEventId
      ? await tx.webhookEvent.findUnique({ where: { id: input.webhookEventId } })
      : await tx.webhookEvent.findFirst({
          where: {
            payload: { path: ["entry"], not: Prisma.DbNull },
            eventSummary: "accepted durable status receipt",
          },
          orderBy: { createdAt: "desc" },
        });
    if (!event) throw new Error("Status WebhookEvent not found");

    const statusEvents = statusesFor(event.payload, input.waMessageId);
    const statusEvent = statusEvents.find((candidate) => candidate.phoneNumberId) ?? statusEvents[0];
    if (!statusEvent) throw new Error("Status WebhookEvent does not contain the requested provider message id");

    const phone = await tx.phoneNumber.findFirst({
      where: {
        id: input.phoneNumberId,
        metaPhoneNumberId: statusEvent.phoneNumberId,
        wabaAccountId: input.wabaAccountId,
        wabaAccount: { tenantId: input.tenantId },
      },
      select: { id: true },
    });
    if (!phone) throw new Error("Status tenant/WABA/phone ownership check failed");

    const incoming = STATUS_MAP[statusEvent.status.status ?? ""];
    if (!incoming) throw new Error(`Unsupported status: ${statusEvent.status.status}`);

    const finalStatus = nextStatus(message.status, incoming);
    const errorJson = statusEvent.status.errors?.length ? (statusEvent.status.errors as object) : undefined;
    const changed = finalStatus !== message.status || !!errorJson;
    if (changed) {
      await tx.message.update({
        where: { id: message.id },
        data: { status: finalStatus, errorJson: errorJson ?? undefined },
      });
    }

    await tx.outboundSendAttempt.updateMany({
      where: {
        messageId: message.id,
        tenantId: input.tenantId,
        waMessageId: input.waMessageId,
        state: { in: ["PENDING", "CLAIMED", "RETRYABLE"] },
      },
      data: { state: incoming === "FAILED" ? "FAILED" : "SENT", finishedAt: new Date(), lastErrorMessage: null, lastErrorCode: null },
    });

    await tx.webhookEvent.update({
      where: { id: event.id },
      data: { processedOk: true, eventSummary: `status ${finalStatus.toLowerCase()} for ${input.waMessageId}`, error: null },
    });

    return {
      messageId: message.id,
      waMessageId: input.waMessageId,
      status: finalStatus,
      changed,
      summary: changed ? `status updated to ${finalStatus}` : `status already ${finalStatus}`,
    };
  });
}
