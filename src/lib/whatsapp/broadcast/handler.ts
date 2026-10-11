import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { graphFetch as defaultGraphFetch, type GraphRequest } from "@/lib/whatsapp/client";
import { getWabaConfig } from "@/lib/settings";
import { ensureConversation } from "@/lib/whatsapp/send";
import { templateExampleComponents } from "@/lib/whatsapp/template-service";
import type { ApiComponent } from "@/lib/whatsapp/template-types";
import { finishPreparedFlowLaunch, prepareTemplateFlowLaunch } from "@/lib/whatsapp/flow-launch";
import { markOutboundMetaRequestStarted } from "@/lib/whatsapp/outbound";
import { classifyError, MetaResponseError } from "@/lib/whatsapp/outbound/handler";
import type { BroadcastDispatchJobPayload } from "@/lib/queue";
import {
  claimBroadcastRecipient,
  markBroadcastRecipientSent,
  markBroadcastRecipientFailed,
  markBroadcastRecipientUncertain,
  type BroadcastPrisma,
} from "./repository";

export interface BroadcastHandlerDependencies {
  db?: BroadcastPrisma;
  graphFetch?: (req: GraphRequest) => Promise<{ messages?: { id: string }[] }>;
  ownerId?: string;
}

export type BroadcastDispatchResult =
  | {
      status: "sent";
      broadcastId: string;
      broadcastRecipientId: string;
      messageId: string;
      waMessageId: string;
    }
  | {
      status: "failed";
      broadcastId: string;
      broadcastRecipientId: string;
      messageId: string;
      errorCode: string;
      error: string;
      metaStatus?: number;
    }
  | {
      status: "uncertain";
      broadcastId: string;
      broadcastRecipientId: string;
      messageId: string;
      errorCode: string;
      error: string;
      metaStatus?: number;
    }
  | {
      status: "skipped";
      broadcastId: string;
      broadcastRecipientId: string;
      reason: string;
    }
  | {
      status: "cancelled";
      broadcastId: string;
      broadcastRecipientId: string;
      reason: "CAMPAIGN_CANCELLED";
    };

export class BroadcastHandlerError extends Error {
  constructor(
    public readonly code: "TENANT_MISMATCH" | "NOT_FOUND" | "CLIENT_ERROR",
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = "BroadcastHandlerError";
  }
}

export async function handleBroadcastDispatch(
  job: BroadcastDispatchJobPayload,
  deps?: BroadcastHandlerDependencies
): Promise<BroadcastDispatchResult> {
  const db = deps?.db ?? prisma;
  const graphFetch = deps?.graphFetch ?? defaultGraphFetch;
  const ownerId = deps?.ownerId ?? `broadcast_worker_${randomUUID().slice(0, 8)}`;

  const { broadcastId, broadcastRecipientId, contactId, tenantId } = job.ref;

  // 1. Re-validate campaign and tenant ownership
  const broadcast = await db.broadcast.findUnique({
    where: { id: broadcastId },
    include: { template: true },
  });

  if (!broadcast) {
    throw new BroadcastHandlerError("NOT_FOUND", "Broadcast not found", 404);
  }

  if (!broadcast.tenantId || broadcast.tenantId !== tenantId) {
    throw new BroadcastHandlerError("TENANT_MISMATCH", "Tenant mismatch in broadcast", 403);
  }

  if (broadcast.template.tenantId !== broadcast.tenantId) {
    throw new BroadcastHandlerError("TENANT_MISMATCH", "Tenant mismatch in broadcast template", 403);
  }

  // 2. Cancellation check
  if (broadcast.status === "CANCELLED") {
    return {
      status: "cancelled",
      broadcastId,
      broadcastRecipientId,
      reason: "CAMPAIGN_CANCELLED",
    };
  }

  if (broadcast.template.status !== "APPROVED") {
    throw new BroadcastHandlerError("CLIENT_ERROR", "Broadcast template is not approved", 400);
  }

  // 3. Re-validate recipient and contact
  const recipient = await db.broadcastRecipient.findUnique({
    where: { id: broadcastRecipientId },
    include: { contact: true },
  });

  if (!recipient) {
    throw new BroadcastHandlerError("NOT_FOUND", "Broadcast recipient not found", 404);
  }

  if (recipient.broadcastId !== broadcast.id) {
    throw new BroadcastHandlerError("CLIENT_ERROR", "Recipient broadcast mismatch", 400);
  }

  if (recipient.contactId !== contactId) {
    throw new BroadcastHandlerError("CLIENT_ERROR", "Recipient contact mismatch", 400);
  }

  if (recipient.contact.tenantId && recipient.contact.tenantId !== broadcast.tenantId) {
    throw new BroadcastHandlerError("TENANT_MISMATCH", "Tenant mismatch in recipient contact", 403);
  }

  if (recipient.status === "SENT") {
    return {
      status: "skipped",
      broadcastId,
      broadcastRecipientId,
      reason: "ALREADY_SENT",
    };
  }

  if (recipient.status === "FAILED") {
    return {
      status: "skipped",
      broadcastId,
      broadcastRecipientId,
      reason: "ALREADY_FAILED",
    };
  }

  // 4. Conversation and Flow setup
  const config = await getWabaConfig();
  const { conversation } = await ensureConversation(
    recipient.contact.waId,
    recipient.contact.name ?? undefined
  );

  if (conversation.tenantId && conversation.tenantId !== broadcast.tenantId) {
    throw new BroadcastHandlerError("TENANT_MISMATCH", "Tenant mismatch in recipient conversation", 403);
  }

  const components = templateExampleComponents(
    broadcast.template.components as unknown as ApiComponent[],
    broadcast.template.category
  );

  const prepared = await prepareTemplateFlowLaunch({
    templateComponents: broadcast.template.components as unknown as ApiComponent[],
    contactId: recipient.contact.id,
    conversationId: conversation.id,
  });

  const preview = `Broadcast: ${broadcast.name}`;

  // 5. Atomic Claim
  const claim = await claimBroadcastRecipient(db, {
    broadcastRecipientId,
    tenantId: broadcast.tenantId,
    ownerId,
    messageData: {
      conversationId: conversation.id,
      text: preview,
      templateId: broadcast.templateId,
      payload: {
        templateName: broadcast.template.name,
        language: broadcast.template.language,
      },
    },
  });

  if (!claim.claimed) {
    if (claim.reason === "CAMPAIGN_CANCELLED") {
      return {
        status: "cancelled",
        broadcastId,
        broadcastRecipientId,
        reason: "CAMPAIGN_CANCELLED",
      };
    }
    return {
      status: "skipped",
      broadcastId,
      broadcastRecipientId,
      reason: claim.reason,
    };
  }

  const { attempt, messageId } = claim;

  // 6. Mark metaRequestStartedAt before crossing provider boundary
  const started = await markOutboundMetaRequestStarted(db, {
    attemptId: attempt.id,
    ownerId,
  });

  if (!started) {
    return {
      status: "skipped",
      broadcastId,
      broadcastRecipientId,
      reason: "ALREADY_CLAIMED",
    };
  }

  // 7. Meta API invocation
  const requestBody = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient.contact.waId,
    type: "template",
    template: {
      name: broadcast.template.name,
      language: { code: broadcast.template.language },
      components: [...components, ...(prepared ? [prepared.sendComponent] : [])],
    },
  };

  try {
    const res = await graphFetch({
      method: "POST",
      path: `/${config.phoneNumberId}/messages`,
      body: requestBody,
      related: { type: "message", id: messageId },
      config,
    });

    const waMessageId = res.messages?.[0]?.id;
    if (!waMessageId) {
      throw new MetaResponseError("MISSING_MESSAGE_ID", "Meta response omitted messages[0].id", res);
    }

    if (prepared) {
      await finishPreparedFlowLaunch(prepared.launchId, messageId);
    }

    await markBroadcastRecipientSent(db, {
      broadcastRecipientId,
      broadcastId,
      messageId,
      attemptId: attempt.id,
      waMessageId,
      conversationId: conversation.id,
      preview,
    });

    return {
      status: "sent",
      broadcastId,
      broadcastRecipientId,
      messageId,
      waMessageId,
    };
  } catch (err) {
    const classification = classifyError(err);

    if (classification.result === "uncertain") {
      await markBroadcastRecipientUncertain(db, {
        broadcastRecipientId,
        broadcastId,
        messageId,
        attemptId: attempt.id,
        errorCode: classification.errorCode,
        errorMessage: classification.message,
        metaStatus: classification.metaStatus,
      });

      return {
        status: "uncertain",
        broadcastId,
        broadcastRecipientId,
        messageId,
        errorCode: classification.errorCode,
        error: classification.message,
        metaStatus: classification.metaStatus,
      };
    }

    // Certain failure
    if (prepared) {
      await finishPreparedFlowLaunch(prepared.launchId, undefined, err).catch(() => {});
    }

    await markBroadcastRecipientFailed(db, {
      broadcastRecipientId,
      broadcastId,
      messageId,
      attemptId: attempt.id,
      errorCode: classification.errorCode,
      errorMessage: classification.message,
      metaStatus: classification.metaStatus,
    });

    return {
      status: "failed",
      broadcastId,
      broadcastRecipientId,
      messageId,
      errorCode: classification.errorCode,
      error: classification.message,
      metaStatus: classification.metaStatus,
    };
  }
}
