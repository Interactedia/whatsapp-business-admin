import { prisma } from "@/lib/prisma";
import { addOutboxEvent, type OutboxPrisma } from "@/lib/outbox";
import { createBroadcastDispatchJobPayload, JOB_TYPES } from "@/lib/queue";
import { WhatsAppApiError } from "@/lib/whatsapp/client";

export interface DispatchBroadcastResult {
  broadcastId: string;
  totalRecipients: number;
  dispatchedCount: number;
  skippedCount: number;
}

export async function dispatchBroadcast(
  broadcastId: string,
  db: OutboxPrisma = prisma
): Promise<DispatchBroadcastResult> {
  const broadcast = await db.broadcast.findUnique({
    where: { id: broadcastId },
    include: {
      template: true,
      recipients: {
        where: { status: "PENDING" },
      },
    },
  });

  if (!broadcast) {
    throw new WhatsAppApiError(404, "Broadcast not found");
  }

  if (!broadcast.tenantId || broadcast.template.tenantId !== broadcast.tenantId) {
    throw new WhatsAppApiError(403, "Broadcast tenant mismatch.");
  }

  if (broadcast.template.status !== "APPROVED") {
    throw new WhatsAppApiError(400, "Broadcast template must be approved.");
  }

  if (broadcast.status === "CANCELLED") {
    throw new WhatsAppApiError(400, "Cannot dispatch cancelled broadcast.");
  }

  const tenantId = broadcast.tenantId;

  // Resolve authorized WABA account for tenant.
  const waba = await db.wabaAccount.findFirst({
    where: { tenantId },
  });
  const wabaAccountId = waba?.id ?? `${tenantId}_waba`;

  return db.$transaction(async (tx) => {
    // Check for existing outbox events for this broadcast to prevent duplicate dispatch
    const existingEvents = await tx.$queryRaw<{ recipientId: string }[]>`
      SELECT "payload"->'ref'->>'broadcastRecipientId' as "recipientId"
      FROM "OutboxEvent"
      WHERE "tenantId" = ${tenantId}
        AND "eventType" = ${JOB_TYPES.BROADCAST_DISPATCH}
        AND "payload"->'ref'->>'broadcastId' = ${broadcast.id}
    `;
    const existingRecipientIds = new Set(existingEvents.map((e) => e.recipientId));

    if (broadcast.status === "DRAFT" || broadcast.status === "QUEUED") {
      await tx.broadcast.update({
        where: { id: broadcast.id },
        data: { status: "RUNNING" },
      });
    }

    let dispatchedCount = 0;
    let skippedCount = 0;

    for (const recipient of broadcast.recipients) {
      if (existingRecipientIds.has(recipient.id)) {
        skippedCount++;
        continue;
      }

      const payload = createBroadcastDispatchJobPayload({
        tenantId,
        wabaAccountId,
        broadcastId: broadcast.id,
        broadcastRecipientId: recipient.id,
        contactId: recipient.contactId,
        producer: "queue-producer",
      });

      await addOutboxEvent(tx, {
        tenantId,
        payload,
      });

      dispatchedCount++;
    }

    return {
      broadcastId: broadcast.id,
      totalRecipients: broadcast.total,
      dispatchedCount,
      skippedCount,
    };
  });
}
