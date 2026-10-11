import { JOB_CONTRACT_VERSION, JOB_TYPES, type BroadcastDispatchJobPayload, type ProducerIdentity } from "../contracts";
import { validateJobPayload } from "./validation";

export interface CreateBroadcastDispatchJobInput {
  tenantId: string;
  wabaAccountId: string;
  broadcastId: string;
  broadcastRecipientId: string;
  contactId: string;
  producer?: ProducerIdentity;
  enqueuedAt?: string;
}

export function createBroadcastDispatchJobPayload(input: CreateBroadcastDispatchJobInput): BroadcastDispatchJobPayload {
  return validateJobPayload({
    type: JOB_TYPES.BROADCAST_DISPATCH,
    version: JOB_CONTRACT_VERSION,
    producer: input.producer ?? "queue-producer",
    enqueuedAt: input.enqueuedAt ?? new Date().toISOString(),
    ref: {
      tenantId: input.tenantId,
      wabaAccountId: input.wabaAccountId,
      broadcastId: input.broadcastId,
      broadcastRecipientId: input.broadcastRecipientId,
      contactId: input.contactId,
    },
  }) as BroadcastDispatchJobPayload;
}
