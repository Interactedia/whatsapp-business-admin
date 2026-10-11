import { JOB_CONTRACT_VERSION, type StatusReconciliationJobPayload } from "@/lib/queue";
import { reconcileStatusEvent, type StatusReconciliationResult } from "./reconciliation";

export async function processStatusReconciliationJob(job: StatusReconciliationJobPayload): Promise<StatusReconciliationResult> {
  if (job.version !== JOB_CONTRACT_VERSION) throw new Error(`Unsupported status job contract version ${job.version}`);
  if (!job.ref.waMessageId) throw new Error("Status job payload requires waMessageId");

  return reconcileStatusEvent({
    webhookEventId: job.ref.webhookEventId,
    tenantId: job.ref.tenantId,
    wabaAccountId: job.ref.wabaAccountId,
    phoneNumberId: job.ref.phoneNumberId,
    messageId: job.ref.messageId,
    waMessageId: job.ref.waMessageId,
  });
}
