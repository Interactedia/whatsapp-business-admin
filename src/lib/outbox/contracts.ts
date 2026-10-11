import type { Queue } from "bullmq";
import { JOB_CONTRACT_VERSION, type KnownJobPayload } from "@/lib/queue";
import { validateJobPayload } from "@/lib/queue/jobs";

export const OUTBOX_CONTRACT_VERSION = JOB_CONTRACT_VERSION;
export const OUTBOX_DEFAULT_MAX_ATTEMPTS = 5;
export const OUTBOX_DEFAULT_BATCH_SIZE = 25;
export const OUTBOX_DEFAULT_LEASE_MS = 30_000;
export const OUTBOX_DEFAULT_RETRY_DELAY_MS = 5_000;

export const OUTBOX_STATES = {
  PENDING: "PENDING",
  CLAIMED: "CLAIMED",
  PUBLISHED: "PUBLISHED",
  RETRYABLE: "RETRYABLE",
  TERMINAL: "TERMINAL",
} as const;

export type OutboxState = typeof OUTBOX_STATES[keyof typeof OUTBOX_STATES];

export interface OutboxEventInput {
  tenantId: string;
  payload: KnownJobPayload;
  maxAttempts?: number;
  nextAttemptAt?: Date;
}

export interface OutboxEventRecord {
  id: string;
  tenantId: string;
  eventType: string;
  contractVersion: number;
  payload: KnownJobPayload;
  state: OutboxState;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  claimedBy: string | null;
  claimExpiresAt: Date | null;
  publishedAt: Date | null;
  failureCode: string | null;
  failureMessage: string | null;
  lastAttemptedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClaimOutboxEventsOptions {
  dispatcherId: string;
  batchSize?: number;
  leaseMs?: number;
  now?: Date;
}

export interface OutboxDispatchOptions {
  dispatcherId: string;
  batchSize?: number;
  leaseMs?: number;
  retryDelayMs?: number;
  queue?: Queue<KnownJobPayload>;
}

export interface OutboxDispatchResult {
  claimed: number;
  published: number;
  failed: number;
  terminal: number;
}

export interface OutboxInspectionSummary {
  pending: number;
  claimed: number;
  published: number;
  retryable: number;
  terminal: number;
  expiredLeases: number;
  oldestPendingAgeMs: number | null;
}

export class OutboxError extends Error {
  constructor(
    public readonly code: "INVALID_EVENT" | "CLAIM_OWNERSHIP" | "UNSUPPORTED_STATE",
    message: string,
    public readonly details: string[] = []
  ) {
    super(message);
    this.name = "OutboxError";
  }
}

export function validateOutboxEventInput(input: OutboxEventInput): KnownJobPayload {
  const payload = validateJobPayload(input.payload);
  if (payload.ref.tenantId !== input.tenantId) {
    throw new OutboxError("INVALID_EVENT", "Outbox tenantId must match payload tenant reference");
  }
  if (input.maxAttempts !== undefined && (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1)) {
    throw new OutboxError("INVALID_EVENT", "maxAttempts must be a positive integer");
  }
  return payload;
}

export function sanitizeFailure(error: unknown): { code: string; message: string } {
  const raw = error instanceof Error ? error.message : String(error);
  return {
    code: error instanceof Error ? error.name : "PublicationError",
    message: raw.replace(/(redis:\/\/)([^@\s]+)@/gi, "$1[redacted]@").slice(0, 500),
  };
}
