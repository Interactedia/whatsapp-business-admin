import { JOB_CONTRACT_VERSION, JOB_TYPES, type InboundWebhookJobPayload, type ProducerIdentity } from "../contracts";
import { validateJobPayload } from "./validation";

export interface CreateInboundWebhookJobInput {
  tenantId: string;
  wabaAccountId: string;
  phoneNumberId: string;
  webhookEventId: string;
  producer?: ProducerIdentity;
  enqueuedAt?: string;
  source?: "meta-webhook" | "integration-test";
}

export function createInboundWebhookJobPayload(input: CreateInboundWebhookJobInput): InboundWebhookJobPayload {
  return validateJobPayload({
    type: JOB_TYPES.INBOUND_WEBHOOK,
    version: JOB_CONTRACT_VERSION,
    producer: input.producer ?? "queue-producer",
    enqueuedAt: input.enqueuedAt ?? new Date().toISOString(),
    ref: {
      tenantId: input.tenantId,
      wabaAccountId: input.wabaAccountId,
      phoneNumberId: input.phoneNumberId,
      webhookEventId: input.webhookEventId,
    },
    ...(input.source ? { metadata: { source: input.source } } : {}),
  }) as InboundWebhookJobPayload;
}
