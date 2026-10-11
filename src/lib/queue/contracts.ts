/**
 * ERA 2 — Typed job contracts.
 *
 * Jobs carry minimal persisted references. PostgreSQL remains authoritative and
 * workers must re-check tenant ownership before side effects.
 */

import { QUEUE_NAMES, type QueueName } from "./config";

export const JOB_CONTRACT_VERSION = 1 as const;

export const JOB_TYPES = {
  INBOUND_WEBHOOK: "inbound.webhook",
  OUTBOUND_MESSAGE: "outbound.message",
  STATUS_RECONCILIATION: "status.reconciliation",
  BROADCAST_DISPATCH: "broadcast.dispatch",
} as const;

export type JobType = typeof JOB_TYPES[keyof typeof JOB_TYPES];

export const JOB_NAMES = {
  PROCESS_WEBHOOK_EVENT: "process-webhook-event",
  SEND_MESSAGE: "send-message",
  RECONCILE_STATUS: "reconcile-status",
  DISPATCH_BROADCAST_RECIPIENT: "dispatch-broadcast-recipient",
} as const;

export type JobName = typeof JOB_NAMES[keyof typeof JOB_NAMES];

export type ProducerIdentity = "queue-producer" | "integration-test" | `manual:${string}`;

export interface JobReferenceBase {
  tenantId: string;
  wabaAccountId: string;
}

export interface PhoneScopedJobReference extends JobReferenceBase {
  phoneNumberId: string;
}

export interface BaseJobPayload<TType extends JobType = JobType> {
  type: TType;
  version: typeof JOB_CONTRACT_VERSION;
  producer: ProducerIdentity;
  enqueuedAt: string;
}

export interface InboundWebhookJobPayload extends BaseJobPayload<typeof JOB_TYPES.INBOUND_WEBHOOK> {
  ref: PhoneScopedJobReference & {
    webhookEventId: string;
  };
  metadata?: {
    source?: "meta-webhook" | "integration-test";
  };
}

export interface OutboundMessageJobPayload extends BaseJobPayload<typeof JOB_TYPES.OUTBOUND_MESSAGE> {
  ref: PhoneScopedJobReference & {
    conversationId: string;
    messageId: string;
  };
}

export interface StatusReconciliationJobPayload extends BaseJobPayload<typeof JOB_TYPES.STATUS_RECONCILIATION> {
  ref: PhoneScopedJobReference & {
    messageId: string;
    waMessageId?: string;
  };
  metadata?: {
    reason?: "scheduled" | "webhook-gap" | "integration-test";
  };
}

export interface BroadcastDispatchJobPayload extends BaseJobPayload<typeof JOB_TYPES.BROADCAST_DISPATCH> {
  ref: JobReferenceBase & {
    broadcastId: string;
    broadcastRecipientId: string;
    contactId: string;
  };
}

export type KnownJobPayload =
  | InboundWebhookJobPayload
  | OutboundMessageJobPayload
  | StatusReconciliationJobPayload
  | BroadcastDispatchJobPayload;

export interface JobContract<TPayload extends KnownJobPayload = KnownJobPayload> {
  type: TPayload["type"];
  version: typeof JOB_CONTRACT_VERSION;
  queueName: QueueName;
  jobName: JobName;
  futureConsumerBoundary: string;
}

export const JOB_CONTRACTS = {
  [JOB_TYPES.INBOUND_WEBHOOK]: {
    type: JOB_TYPES.INBOUND_WEBHOOK,
    version: JOB_CONTRACT_VERSION,
    queueName: QUEUE_NAMES.INBOUND_WEBHOOK,
    jobName: JOB_NAMES.PROCESS_WEBHOOK_EVENT,
    futureConsumerBoundary: "Fetch WebhookEvent, verify Tenant/WABA/PhoneNumber ownership, then process inbound event.",
  },
  [JOB_TYPES.OUTBOUND_MESSAGE]: {
    type: JOB_TYPES.OUTBOUND_MESSAGE,
    version: JOB_CONTRACT_VERSION,
    queueName: QUEUE_NAMES.OUTBOUND_MESSAGE,
    jobName: JOB_NAMES.SEND_MESSAGE,
    futureConsumerBoundary: "Fetch Message and Conversation, verify Tenant/WABA/PhoneNumber ownership, then call Meta.",
  },
  [JOB_TYPES.STATUS_RECONCILIATION]: {
    type: JOB_TYPES.STATUS_RECONCILIATION,
    version: JOB_CONTRACT_VERSION,
    queueName: QUEUE_NAMES.STATUS_RECONCILIATION,
    jobName: JOB_NAMES.RECONCILE_STATUS,
    futureConsumerBoundary: "Fetch Message by local/Meta id, verify Tenant/WABA/PhoneNumber ownership, then reconcile status.",
  },
  [JOB_TYPES.BROADCAST_DISPATCH]: {
    type: JOB_TYPES.BROADCAST_DISPATCH,
    version: JOB_CONTRACT_VERSION,
    queueName: QUEUE_NAMES.BROADCAST_DISPATCH,
    jobName: JOB_NAMES.DISPATCH_BROADCAST_RECIPIENT,
    futureConsumerBoundary: "Fetch BroadcastRecipient and Broadcast, verify Tenant/WABA ownership, then dispatch one recipient.",
  },
} as const satisfies Record<JobType, JobContract>;

export { QUEUE_NAMES, type QueueName };
