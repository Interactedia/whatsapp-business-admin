import { prisma } from "@/lib/prisma";
import { JOB_CONTRACT_VERSION, type InboundWebhookJobPayload } from "@/lib/queue";
import { processWebhook } from "@/lib/whatsapp/webhook";

export interface InboundProcessingResult {
  webhookEventId: string;
  summary: string;
}

export async function processInboundWebhookJob(job: InboundWebhookJobPayload): Promise<InboundProcessingResult> {
  if (job.version !== JOB_CONTRACT_VERSION) throw new Error(`Unsupported inbound job contract version ${job.version}`);

  const event = await prisma.webhookEvent.findUnique({ where: { id: job.ref.webhookEventId } });
  if (!event) throw new Error(`WebhookEvent not found: ${job.ref.webhookEventId}`);

  const phone = await prisma.phoneNumber.findFirst({
    where: {
      id: job.ref.phoneNumberId,
      wabaAccountId: job.ref.wabaAccountId,
      wabaAccount: { tenantId: job.ref.tenantId },
    },
    select: { id: true },
  });
  if (!phone) throw new Error("Inbound job tenant/WABA ownership check failed");

  try {
    const summary = await processWebhook(event.payload);
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { processedOk: true, eventSummary: summary, error: null },
    });
    return { webhookEventId: event.id, summary };
  } catch (error) {
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: {
        processedOk: false,
        eventSummary: "async processing error",
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}
