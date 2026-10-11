import {
  JOB_CONTRACT_VERSION,
  JOB_CONTRACTS,
  JOB_TYPES,
  type JobType,
  type KnownJobPayload,
} from "../contracts";

const SENSITIVE_KEY_PATTERN = /(token|secret|password|credential|authorization|accessToken|appSecret)/i;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9_.-]{1,512}$/;

export type JobValidationErrorCode =
  | "INVALID_PAYLOAD"
  | "UNSUPPORTED_VERSION"
  | "UNSUPPORTED_JOB_TYPE"
  | "SENSITIVE_FIELD"
  | "INVALID_JOB_IDENTITY";

export class JobValidationError extends Error {
  constructor(
    public readonly code: JobValidationErrorCode,
    message: string,
    public readonly details: string[] = []
  ) {
    super(message);
    this.name = "JobValidationError";
  }
}

export interface JobIdentityInput {
  type: JobType;
  version: number;
  tenantId: string;
  wabaAccountId: string;
  recordId: string;
  recordKind: string;
}

export interface JobIdentity {
  jobId: string;
  parts: JobIdentityInput;
  limitation: "BullMQ jobId helps coalesce queued jobs only; it is not an exactly-once business guarantee.";
}

export function validateJobPayload(payload: unknown): KnownJobPayload {
  const errors: string[] = [];

  if (!isRecord(payload)) {
    throw new JobValidationError("INVALID_PAYLOAD", "Job payload must be an object");
  }

  rejectSensitiveFields(payload);

  if (!isJobType(payload.type)) {
    throw new JobValidationError("UNSUPPORTED_JOB_TYPE", "Unsupported job type");
  }

  if (payload.version !== JOB_CONTRACT_VERSION) {
    throw new JobValidationError("UNSUPPORTED_VERSION", "Unsupported job contract version");
  }

  if (!isProducer(payload.producer)) errors.push("producer is required");
  if (!isIsoDate(payload.enqueuedAt)) errors.push("enqueuedAt must be an ISO date string");
  if (!isRecord(payload.ref)) errors.push("ref is required");

  if (isRecord(payload.ref)) {
    validateBaseRef(payload.ref, errors);
    switch (payload.type) {
      case JOB_TYPES.INBOUND_WEBHOOK:
        validatePhoneRef(payload.ref, errors);
        requiredId(payload.ref.webhookEventId, "webhookEventId", errors);
        break;
      case JOB_TYPES.OUTBOUND_MESSAGE:
        validatePhoneRef(payload.ref, errors);
        requiredId(payload.ref.conversationId, "conversationId", errors);
        requiredId(payload.ref.messageId, "messageId", errors);
        break;
      case JOB_TYPES.STATUS_RECONCILIATION:
        validatePhoneRef(payload.ref, errors);
        requiredId(payload.ref.messageId, "messageId", errors);
        if (payload.ref.waMessageId !== undefined) requiredId(payload.ref.waMessageId, "waMessageId", errors);
        break;
      case JOB_TYPES.BROADCAST_DISPATCH:
        requiredId(payload.ref.broadcastId, "broadcastId", errors);
        requiredId(payload.ref.broadcastRecipientId, "broadcastRecipientId", errors);
        requiredId(payload.ref.contactId, "contactId", errors);
        break;
    }
  }

  if (errors.length > 0) {
    throw new JobValidationError("INVALID_PAYLOAD", "Invalid job payload", errors);
  }

  return payload as unknown as KnownJobPayload;
}

export function getJobContract(payload: KnownJobPayload) {
  return JOB_CONTRACTS[payload.type];
}

export function buildJobIdentity(input: JobIdentityInput): JobIdentity {
  const errors: string[] = [];
  if (!isJobType(input.type)) errors.push("type is unsupported");
  if (input.version !== JOB_CONTRACT_VERSION) errors.push("version is unsupported");
  requiredId(input.tenantId, "tenantId", errors);
  requiredId(input.wabaAccountId, "wabaAccountId", errors);
  requiredId(input.recordId, "recordId", errors);
  requiredId(input.recordKind, "recordKind", errors);

  const jobId = [
    input.type,
    `v${input.version}`,
    input.tenantId,
    input.wabaAccountId,
    input.recordKind,
    input.recordId,
  ].map(encodeURIComponent).join(".");

  if (!JOB_ID_PATTERN.test(jobId)) errors.push("jobId contains unsupported characters or is too long");
  if (errors.length > 0) {
    throw new JobValidationError("INVALID_JOB_IDENTITY", "Invalid job identity", errors);
  }

  return {
    jobId,
    parts: input,
    limitation: "BullMQ jobId helps coalesce queued jobs only; it is not an exactly-once business guarantee.",
  };
}

export function buildJobIdentityForPayload(payload: KnownJobPayload): JobIdentity {
  const valid = validateJobPayload(payload);
  const base = {
    type: valid.type,
    version: valid.version,
    tenantId: valid.ref.tenantId,
    wabaAccountId: valid.ref.wabaAccountId,
  };

  switch (valid.type) {
    case JOB_TYPES.INBOUND_WEBHOOK:
      return buildJobIdentity({ ...base, recordKind: "webhookEvent", recordId: valid.ref.webhookEventId });
    case JOB_TYPES.OUTBOUND_MESSAGE:
      return buildJobIdentity({ ...base, recordKind: "message", recordId: valid.ref.messageId });
    case JOB_TYPES.STATUS_RECONCILIATION:
      return buildJobIdentity({ ...base, recordKind: "message", recordId: valid.ref.messageId });
    case JOB_TYPES.BROADCAST_DISPATCH:
      return buildJobIdentity({ ...base, recordKind: "broadcastRecipient", recordId: valid.ref.broadcastRecipientId });
  }
}

function validateBaseRef(ref: Record<string, unknown>, errors: string[]) {
  requiredId(ref.tenantId, "tenantId", errors);
  requiredId(ref.wabaAccountId, "wabaAccountId", errors);
}

function validatePhoneRef(ref: Record<string, unknown>, errors: string[]) {
  requiredId(ref.phoneNumberId, "phoneNumberId", errors);
}

function requiredId(value: unknown, label: string, errors: string[]) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    errors.push(`${label} must be a non-empty persisted identifier`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isProducer(value: unknown): value is string {
  return typeof value === "string" && (value === "queue-producer" || value === "integration-test" || value.startsWith("manual:"));
}

function isJobType(value: unknown): value is JobType {
  return Object.values(JOB_TYPES).includes(value as JobType);
}

function rejectSensitiveFields(value: unknown, path = "payload") {
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      throw new JobValidationError("SENSITIVE_FIELD", "Job payload contains a sensitive field", [childPath]);
    }
    if (isRecord(child)) rejectSensitiveFields(child, childPath);
  }
}
