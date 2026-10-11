import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import {
  getOrCreateOutboundAttempt,
  claimOutboundAttempt,
  markOutboundSent,
  markOutboundFailed,
  markOutboundUncertain,
  type OutboundAttemptRecord,
} from "@/lib/whatsapp/outbound";

export type BroadcastPrisma = Prisma.TransactionClient | typeof prisma;

export interface ClaimRecipientSendInput {
  broadcastRecipientId: string;
  tenantId: string;
  ownerId: string;
  leaseMs?: number;
  messageData: {
    conversationId: string;
    text: string;
    templateId: string;
    payload?: Prisma.InputJsonValue;
  };
}

export type ClaimRecipientSendResult =
  | {
      claimed: true;
      attempt: OutboundAttemptRecord;
      messageId: string;
      broadcastId: string;
    }
  | {
      claimed: false;
      reason: string;
      existingState?: string | null;
    }
  | {
      claimed: false;
      reason: "CAMPAIGN_CANCELLED";
    };

/**
 * Atomically claim execution of a broadcast recipient.
 *
 * Guarantees:
 * - Checks current broadcast status (stops if CANCELLED).
 * - Creates/reuses exactly one Message and OutboundSendAttempt per recipient.
 * - Enforces atomic execution ownership via PostgreSQL OutboundSendAttempt claim.
 */
export async function claimBroadcastRecipient(
  db: BroadcastPrisma,
  input: ClaimRecipientSendInput
): Promise<ClaimRecipientSendResult> {
  return db.$transaction(async (tx) => {
    const recipient = await tx.broadcastRecipient.findUnique({
      where: { id: input.broadcastRecipientId },
      include: {
        broadcast: { select: { id: true, status: true, tenantId: true } },
      },
    });

    if (!recipient) {
      return { claimed: false, reason: "RECIPIENT_NOT_FOUND" };
    }

    if (recipient.broadcast.status === "CANCELLED") {
      return { claimed: false, reason: "CAMPAIGN_CANCELLED" };
    }

    if (recipient.status === "SENT") {
      return { claimed: false, reason: "ALREADY_SENT", existingState: "SENT" };
    }
    if (recipient.status === "FAILED") {
      return { claimed: false, reason: "ALREADY_FAILED", existingState: "FAILED" };
    }

    let messageId = recipient.messageId;

    if (!messageId) {
      const message = await tx.message.create({
        data: {
          tenantId: input.tenantId,
          conversationId: input.messageData.conversationId,
          direction: "OUT",
          type: "TEMPLATE",
          status: "PENDING",
          text: input.messageData.text,
          templateId: input.messageData.templateId,
          payload: input.messageData.payload,
        },
      });
      messageId = message.id;

      await tx.broadcastRecipient.update({
        where: { id: recipient.id },
        data: { messageId },
      });
    }

    await getOrCreateOutboundAttempt(tx, {
      messageId,
      tenantId: input.tenantId,
    });

    const claim = await claimOutboundAttempt(tx, {
      messageId,
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      leaseMs: input.leaseMs ?? 60_000,
    });

    if (!claim.claimed) {
      return {
        claimed: false,
        reason: "ALREADY_CLAIMED",
        existingState: claim.existingState,
      };
    }

    return {
      claimed: true,
      attempt: claim.attempt!,
      messageId,
      broadcastId: recipient.broadcastId,
    };
  });
}

/**
 * Mark a broadcast recipient as SENT, recording waMessageId and updating counters.
 */
export async function markBroadcastRecipientSent(
  db: BroadcastPrisma,
  input: {
    broadcastRecipientId: string;
    broadcastId: string;
    messageId: string;
    attemptId: string;
    waMessageId: string;
    conversationId: string;
    preview: string;
  }
): Promise<void> {
  await db.$transaction(async (tx) => {
    await markOutboundSent(tx, {
      attemptId: input.attemptId,
      waMessageId: input.waMessageId,
    });

    await tx.message.update({
      where: { id: input.messageId },
      data: { status: "SENT", waMessageId: input.waMessageId },
    });

    await tx.conversation.update({
      where: { id: input.conversationId },
      data: { lastMessageAt: new Date(), lastPreview: input.preview.slice(0, 140) },
    });

    await tx.broadcastRecipient.update({
      where: { id: input.broadcastRecipientId },
      data: { status: "SENT", waMessageId: input.waMessageId, error: null },
    });

    await tx.broadcast.update({
      where: { id: input.broadcastId },
      data: { sentCount: { increment: 1 } },
    });
  });

  await maybeCompleteBroadcast(db, input.broadcastId);
}

/**
 * Mark a broadcast recipient as FAILED (terminal certain failure).
 */
export async function markBroadcastRecipientFailed(
  db: BroadcastPrisma,
  input: {
    broadcastRecipientId: string;
    broadcastId: string;
    messageId: string;
    attemptId: string;
    errorCode: string;
    errorMessage: string;
    metaStatus?: number;
  }
): Promise<void> {
  await db.$transaction(async (tx) => {
    await markOutboundFailed(tx, {
      attemptId: input.attemptId,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      retryable: false,
      metaStatus: input.metaStatus,
    });

    await tx.message.update({
      where: { id: input.messageId },
      data: {
        status: "FAILED",
        errorJson: {
          code: input.errorCode,
          message: input.errorMessage,
          metaStatus: input.metaStatus,
        },
      },
    });

    await tx.broadcastRecipient.update({
      where: { id: input.broadcastRecipientId },
      data: { status: "FAILED", error: input.errorMessage },
    });

    await tx.broadcast.update({
      where: { id: input.broadcastId },
      data: { failedCount: { increment: 1 } },
    });
  });

  await maybeCompleteBroadcast(db, input.broadcastId);
}

/**
 * Mark a broadcast recipient send as UNCERTAIN (non-retryable terminal protection).
 * Counters are NOT incremented. Status remains PENDING with error annotation.
 */
export async function markBroadcastRecipientUncertain(
  db: BroadcastPrisma,
  input: {
    broadcastRecipientId: string;
    broadcastId: string;
    messageId: string;
    attemptId: string;
    errorCode: string;
    errorMessage: string;
    metaStatus?: number;
  }
): Promise<void> {
  await db.$transaction(async (tx) => {
    await markOutboundUncertain(tx, {
      attemptId: input.attemptId,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      metaStatus: input.metaStatus,
    });

    await tx.message.update({
      where: { id: input.messageId },
      data: {
        errorJson: {
          code: input.errorCode,
          message: input.errorMessage,
          metaStatus: input.metaStatus,
          uncertain: true,
        },
      },
    });

    await tx.broadcastRecipient.update({
      where: { id: input.broadcastRecipientId },
      data: { error: `UNCERTAIN: ${input.errorMessage}` },
    });
  });

  await maybeCompleteBroadcast(db, input.broadcastId);
}

/**
 * Check if all recipients have finished and mark the campaign COMPLETED if currently RUNNING.
 */
export async function maybeCompleteBroadcast(
  db: BroadcastPrisma,
  broadcastId: string
): Promise<boolean> {
  const remaining = await db.broadcastRecipient.count({
    where: { broadcastId, status: "PENDING" },
  });

  if (remaining === 0) {
    const current = await db.broadcast.findUnique({
      where: { id: broadcastId },
      select: { status: true },
    });
    if (current && current.status === "RUNNING") {
      await db.broadcast.update({
        where: { id: broadcastId },
        data: { status: "COMPLETED" },
      });
      return true;
    }
  }
  return false;
}

/**
 * Cancel an active or pending broadcast.
 */
export async function cancelBroadcast(
  db: BroadcastPrisma,
  broadcastId: string,
  tenantId?: string
) {
  const broadcast = await db.broadcast.findUnique({
    where: { id: broadcastId },
  });

  if (!broadcast) {
    throw new Error("Broadcast not found");
  }

  if (tenantId && broadcast.tenantId !== tenantId) {
    throw new Error("Broadcast tenant mismatch");
  }

  if (broadcast.status === "COMPLETED" || broadcast.status === "FAILED") {
    return broadcast;
  }

  return db.broadcast.update({
    where: { id: broadcastId },
    data: { status: "CANCELLED" },
  });
}
