import { JOB_CONTRACT_VERSION, JOB_TYPES, type ProducerIdentity, type StatusReconciliationJobPayload } from "../contracts";
import { validateJobPayload } from "./validation";

export interface CreateStatusReconciliationJobInput {
  tenantId: string;
  wabaAccountId: string;
  phoneNumberId: string;
  messageId: string;
  waMessageId?: string;
  producer?: ProducerIdentity;
  enqueuedAt?: string;
  reason?: "scheduled" | "webhook-gap" | "integration-test";
}

export function createStatusReconciliationJobPayload(input: CreateStatusReconciliationJobInput): StatusReconciliationJobPayload {
  return validateJobPayload({
    type: JOB_TYPES.STATUS_RECONCILIATION,
    version: JOB_CONTRACT_VERSION,
    producer: input.producer ?? "queue-producer",
    enqueuedAt: input.enqueuedAt ?? new Date().toISOString(),
    ref: {
      tenantId: input.tenantId,
      wabaAccountId: input.wabaAccountId,
      phoneNumberId: input.phoneNumberId,
      messageId: input.messageId,
      ...(input.waMessageId ? { waMessageId: input.waMessageId } : {}),
    },
    ...(input.reason ? { metadata: { reason: input.reason } } : {}),
  }) as StatusReconciliationJobPayload;
}
