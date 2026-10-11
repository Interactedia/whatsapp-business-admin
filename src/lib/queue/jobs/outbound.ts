import { JOB_CONTRACT_VERSION, JOB_TYPES, type OutboundMessageJobPayload, type ProducerIdentity } from "../contracts";
import { validateJobPayload } from "./validation";

export interface CreateOutboundMessageJobInput {
  tenantId: string;
  wabaAccountId: string;
  phoneNumberId: string;
  conversationId: string;
  messageId: string;
  producer?: ProducerIdentity;
  enqueuedAt?: string;
}

export function createOutboundMessageJobPayload(input: CreateOutboundMessageJobInput): OutboundMessageJobPayload {
  return validateJobPayload({
    type: JOB_TYPES.OUTBOUND_MESSAGE,
    version: JOB_CONTRACT_VERSION,
    producer: input.producer ?? "queue-producer",
    enqueuedAt: input.enqueuedAt ?? new Date().toISOString(),
    ref: {
      tenantId: input.tenantId,
      wabaAccountId: input.wabaAccountId,
      phoneNumberId: input.phoneNumberId,
      conversationId: input.conversationId,
      messageId: input.messageId,
    },
  }) as OutboundMessageJobPayload;
}
