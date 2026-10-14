import PQueue from "p-queue";
import { prisma } from "@/lib/prisma";
import { getTenantWabaConfig } from "@/lib/settings";
import { ensureConversation, sendMessage } from "@/lib/whatsapp/send";
import { templateExampleComponents } from "@/lib/whatsapp/template-service";
import { WhatsAppApiError } from "@/lib/whatsapp/client";
import type { ApiComponent } from "@/lib/whatsapp/template-types";
import { finishPreparedFlowLaunch, prepareTemplateFlowLaunch } from "@/lib/whatsapp/flow-launch";
import {
  isBroadcastAsyncEnabled,
  dispatchBroadcast,
} from "./broadcast/index";

export * from "./broadcast/index";

/**
 * Single in-process queue shared across requests (kept on globalThis so Next's
 * separate route bundles reuse one instance). Concurrency + interval cap keep us
 * within WhatsApp's rate limits without any external broker.
 */
const g = globalThis as unknown as { __waBroadcastQueue?: PQueue };
function queue(): PQueue {
  if (!g.__waBroadcastQueue) {
    g.__waBroadcastQueue = new PQueue({ concurrency: 8, interval: 1000, intervalCap: 20 });
  }
  return g.__waBroadcastQueue;
}

/**
 * Kick off sending for a broadcast.
 * When WHATSAPP_BROADCAST_ASYNC_ENABLED=true, routes through the durable Outbox + BullMQ pipeline.
 * When disabled (default), uses the legacy in-process queue.
 */
export async function runBroadcast(broadcastId: string): Promise<void> {
  if (isBroadcastAsyncEnabled()) {
    await dispatchBroadcast(broadcastId);
    return;
  }
  return runLegacyBroadcast(broadcastId);
}

/**
 * Legacy in-process broadcast execution using PQueue.
 */
export async function runLegacyBroadcast(broadcastId: string): Promise<void> {
  const broadcast = await prisma.broadcast.findUnique({
    where: { id: broadcastId },
    include: { template: true, recipients: { include: { contact: true } } },
  });
  if (!broadcast) throw new WhatsAppApiError(404, "Broadcast not found");
  if (!broadcast.tenantId || broadcast.template.tenantId !== broadcast.tenantId) throw new WhatsAppApiError(403, "Broadcast tenant mismatch.");
  if (broadcast.template.status !== "APPROVED") {
    throw new WhatsAppApiError(400, "Broadcast template must be approved.");
  }

  const config = await getTenantWabaConfig(broadcast.tenantId);
  if (!config?.phoneNumberId) {
    throw new WhatsAppApiError(400, "Tenant WhatsApp is not connected.");
  }
  const phone = await prisma.phoneNumber.findFirst({
    where: { metaPhoneNumberId: config.phoneNumberId },
    include: { wabaAccount: true },
  });
  if (!phone) {
    throw new WhatsAppApiError(400, "Authorized sender phone number not found.");
  }
  const components = templateExampleComponents(
    broadcast.template.components as unknown as ApiComponent[],
    broadcast.template.category,
  );

  await prisma.broadcast.update({ where: { id: broadcastId }, data: { status: "RUNNING" } });

  const pending = broadcast.recipients.filter((r) => r.status === "PENDING");

  for (const recipient of pending) {
    queue().add(async () => {
      let preparedLaunchId: string | undefined;
      try {
        const { contact, conversation } = await ensureConversation(
          recipient.contact.waId,
          recipient.contact.name ?? undefined,
          phone
        );
        if (contact.tenantId !== broadcast.tenantId || conversation.tenantId !== broadcast.tenantId) throw new WhatsAppApiError(403, "Broadcast recipient tenant mismatch.");
        const prepared = await prepareTemplateFlowLaunch({
          templateComponents: broadcast.template.components as unknown as ApiComponent[],
          contactId: contact.id,
          conversationId: conversation.id,
        });
        preparedLaunchId = prepared?.launchId;
        const message = await sendMessage({
          conversationId: conversation.id,
          to: recipient.contact.waId,
          config,
          content: {
            kind: "template",
            templateId: broadcast.templateId,
            templateName: broadcast.template.name,
            language: broadcast.template.language,
            components: [...components, ...(prepared ? [prepared.sendComponent] : [])],
            templateComponents: broadcast.template.components,
          },
        });
        if (prepared) await finishPreparedFlowLaunch(prepared.launchId, message.id);
        await prisma.broadcastRecipient.update({
          where: { id: recipient.id },
          data: { status: "SENT", waMessageId: message.waMessageId },
        });
        await prisma.broadcast.update({ where: { id: broadcastId }, data: { sentCount: { increment: 1 } } });
      } catch (e) {
        if (preparedLaunchId) await finishPreparedFlowLaunch(preparedLaunchId, undefined, e);
        await prisma.broadcastRecipient.update({
          where: { id: recipient.id },
          data: { status: "FAILED", error: e instanceof Error ? e.message : String(e) },
        });
        await prisma.broadcast.update({ where: { id: broadcastId }, data: { failedCount: { increment: 1 } } });
      } finally {
        await maybeComplete(broadcastId);
      }
    });
  }
}

async function maybeComplete(broadcastId: string): Promise<void> {
  const remaining = await prisma.broadcastRecipient.count({
    where: { broadcastId, status: "PENDING" },
  });
  if (remaining === 0) {
    await prisma.broadcast.update({ where: { id: broadcastId }, data: { status: "COMPLETED" } });
  }
}
