/**
 * ERA 2 — Job Contract Foundation.
 *
 * Minimal internal job typing matching docs/architecture/era2-queue-contracts.md.
 *
 * Invariants:
 * - PostgreSQL is the canonical system of record.
 * - Payloads carry minimal database references (IDs), never full message bodies,
 *   customer PII, or raw media buffers.
 * - Generic typing for future business workers.
 */

import { QUEUE_NAMES, type QueueName } from "./config";

export const JOB_NAMES = {
  PROCESS_WEBHOOK_EVENT: "process-webhook-event",
  SEND_MESSAGE: "send-message",
  RECONCILE_STATUS: "reconcile-status",
  DISPATCH_BROADCAST_RECIPIENT: "dispatch-broadcast-recipient",
} as const;

export type JobName = typeof JOB_NAMES[keyof typeof JOB_NAMES];

export interface BaseJobPayload {
  version: number;
  tenantId?: string;
  enqueuedAt: string;
}

export interface InboundWebhookJobPayload extends BaseJobPayload {
  webhookEventId: string;
  metaPhoneNumberId?: string;
}

export interface OutboundMessageJobPayload extends BaseJobPayload {
  messageId: string;
  phoneNumberId: string;
}

export interface StatusReconciliationJobPayload extends BaseJobPayload {
  messageId: string;
  status: string;
  timestamp: string;
}

export interface BroadcastDispatchJobPayload extends BaseJobPayload {
  broadcastId: string;
  recipientId: string;
}

export type KnownJobPayload =
  | InboundWebhookJobPayload
  | OutboundMessageJobPayload
  | StatusReconciliationJobPayload
  | BroadcastDispatchJobPayload;

export { QUEUE_NAMES, type QueueName };
