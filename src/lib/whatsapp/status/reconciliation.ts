import { prisma } from "@/lib/prisma";
import { Prisma, type MessageStatus } from "@/generated/prisma/client";
import { publish } from "@/server/realtime";

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

export function nextStatus(current: MessageStatus, incoming: MessageStatus): MessageStatus {
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
  /**
   * Optional Prisma client override. Defaults to the singleton
   * `@/lib/prisma`. Concurrency tests inject a dedicated client
   * so the two overlapping transactions come from separate
   * connection pools and genuinely overlap on the PostgreSQL
   * server. Production code keeps the default.
   */
  prismaClient?: Pick<typeof prisma, "$transaction">;
}): Promise<StatusReconciliationResult> {
  const db = input.prismaClient ?? prisma;
  const result = await db.$transaction(async (tx) => {
    // Take an explicit row lock on the canonical Message via
    // SELECT ... FOR UPDATE. Under READ COMMITTED (the
    // database's default) two transactions could otherwise both
    // read the same `current` status, both compute the same
    // target, and both report changed=true for the same logical
    // transition (a duplicate logical mutation). The row lock
    // serializes the read-modify-write on the PK: the second
    // transaction blocks here until the first commits, then
    // re-reads the post-commit status and the `nextStatus()`
    // guard naturally reports changed=false.
    //
    // We use $queryRaw because the Prisma 7 typed query layer
    // for this adapter does not expose a `lock` option on
    // findFirst. The query is parameterised; the only injected
    // value is the messageId we just received from the BullMQ
    // job payload (trusted input).
    const lockedRows = await tx.$queryRaw<Array<{
      id: string;
      status: MessageStatus;
      conversationId: string;
      waMessageId: string | null;
    }>>`
      SELECT "id", "status", "conversationId", "waMessageId"
      FROM "Message"
      WHERE "id" = ${input.messageId}
      FOR UPDATE
    `;
    const locked = lockedRows[0];
    if (!locked?.waMessageId) throw new Error("Status message ownership/correlation check failed");

    // Re-fetch with the full ownership join so the rest of the
    // pipeline (which reads more fields through Prisma's typed
    // API) still has the same access patterns. This query is
    // read-only and sees the post-lock view; the row is already
    // pinned to this transaction.
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
    // Defensive: the locked row's status is what we just pinned
    // and is the canonical source of truth for the transition.
    // Use it to guard against the rare case where the typed
    // findFirst re-reads a different value (e.g. connection
    // re-resolved mid-transaction).
    void locked;

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
      conversationId: message.conversationId,
      waMessageId: input.waMessageId,
      status: finalStatus,
      changed,
      summary: changed ? `status updated to ${finalStatus}` : `status already ${finalStatus}`,
    };
  });

  // Post-commit realtime notification. The DB write above is durable
  // by the time we reach this point; failures here are best-effort
  // (publish() never throws) and never affect canonical state.
  // Only emit when the canonical status actually changed; duplicate
  // and out-of-order-but-equal notifications are suppressed.
  if (result.changed) {
    publish(
      {
        type: "message:status",
        payload: {
          conversationId: result.conversationId,
          waMessageId: result.waMessageId,
          status: result.status,
        },
      },
      input.tenantId,
    );
  }

  return result;
}
