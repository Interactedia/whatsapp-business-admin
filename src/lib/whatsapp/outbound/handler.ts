/**
 * Outbound message handler.
 *
 * Runs in a BullMQ worker. Calls Meta Graph API and updates both the Message
 * row and the durable OutboundSendAttempt claim.
 *
 * Lifecycle guarantee:
 *   - Execution ownership is enforced by a PostgreSQL atomic claim.
 *   - Duplicate BullMQ jobs cannot send twice (the second claim finds the
 *     attempt already in CLAIMED/SENT/FAILED/UNCERTAIN state).
 *   - Concurrent workers cannot send twice (the atomic UPDATE...WHERE returns
 *     at most one row).
 *   - Expired CLAIMED leases do NOT auto-transition UNCERTAIN back to
 *     RETRYABLE — an operator must explicitly retry uncertain messages.
 *   - Crash after the Meta transmission boundary → attempt remains
 *     CLAIMED until lease expires. After lease expiry, the next claim
 *     sees the attempt as RETRYABLE only if the previous state was not
 *     UNCERTAIN.
 *
 * "Uncertain" responses (timeouts, 5xx, rate limits, parse errors, missing
 * message IDs) leave the attempt in UNCERTAIN and the Message in PENDING
 * with a structured error annotation. No automatic retry.
 */

import { prisma } from "@/lib/prisma";
import { addCanonicalEvent } from "@/lib/events";
import { buildConversationStatusChangedEvent, buildOutboundMessageStatusChangedEvent } from "@/lib/events/producers";
import { graphFetch as defaultGraphFetch, WhatsAppApiError, type GraphRequest } from "@/lib/whatsapp/client";
import { phoneNumberConfig, type OwnedPhoneNumber } from "@/lib/tenant/waba";
import { publish } from "@/server/realtime";
import { serializeMessage } from "@/lib/whatsapp/webhook";
import type { OutboundMessageJobPayload } from "@/lib/queue";
import {
  getOrCreateOutboundAttempt,
  claimOutboundAttempt,
  markOutboundMetaRequestStarted,
  markOutboundSent,
  markOutboundFailed,
  markOutboundUncertain,
  type OutboundAttemptRecord,
} from "./repository";

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export const OUTBOUND_ERROR_CODES = {
  TIMEOUT: "TIMEOUT",
  META_SERVER_ERROR: "META_SERVER_ERROR",
  META_RATE_LIMIT: "META_RATE_LIMIT",
  PARSE_ERROR: "PARSE_ERROR",
  MISSING_MESSAGE_ID: "MISSING_MESSAGE_ID",
  NOT_FOUND: "NOT_FOUND",
  AUTH_ERROR: "AUTH_ERROR",
  CLIENT_ERROR: "CLIENT_ERROR",
} as const;
export type OutboundErrorCode = (typeof OUTBOUND_ERROR_CODES)[keyof typeof OUTBOUND_ERROR_CODES];

/**
 * Thrown by the handler when something is wrong with the request itself
 * (e.g. message not found, ownership mismatch). These are NOT transient —
 * the BullMQ job should not be retried.
 */
export class OutboundHandlerError extends Error {
  constructor(
    public readonly code: OutboundErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OutboundHandlerError";
  }
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface OutboundSendSuccess {
  status: "success";
  waMessageId: string;
  messageId: string;
  tenantId: string;
  conversationId: string;
  attemptId: string;
}

export interface OutboundSendFailed {
  status: "failed";
  messageId: string;
  attemptId: string | null;
  errorCode: OutboundErrorCode;
  errorMessage: string;
  retryable: boolean;
}

export interface OutboundSendUncertain {
  status: "uncertain";
  messageId: string;
  attemptId: string;
  errorCode: OutboundErrorCode;
  errorMessage: string;
}

export interface OutboundSendSkipped {
  status: "skipped";
  messageId: string;
  reason: "ALREADY_SENT" | "ALREADY_FAILED" | "ALREADY_UNCERTAIN" | "ALREADY_CLAIMED" | "TERMINAL_STATE";
  existingState: string;
}

export type OutboundSendResult =
  | OutboundSendSuccess
  | OutboundSendFailed
  | OutboundSendUncertain
  | OutboundSendSkipped;

// ---------------------------------------------------------------------------
// Owner identity
// ---------------------------------------------------------------------------

const OWNER_ID = `outbound-worker-${process.pid}`;

export type OutboundGraphFetch = <T = unknown>(req: GraphRequest) => Promise<T>;

export interface OutboundHandlerDependencies {
  graphFetch?: OutboundGraphFetch;
}

// ---------------------------------------------------------------------------
// Payload reconstruction
// ---------------------------------------------------------------------------

type StoredTemplateContent = {
  name: string;
  language: string;
  components: unknown[];
};

async function buildPayloadFromMessage(
  messageId: string,
  message: {
    type: string;
    text: string | null;
    caption: string | null;
    mediaPath: string | null;
    mediaMime: string | null;
    mediaFilename: string | null;
    payload: unknown | null;
  },
  to: string
): Promise<Record<string, unknown>> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to };

  switch (message.type) {
    case "TEXT": {
      return { ...base, type: "text", text: { preview_url: true, body: message.text ?? "" } };
    }

    case "IMAGE":
    case "VIDEO":
    case "AUDIO":
    case "DOCUMENT": {
      const mediaType = message.type.toLowerCase();
      const mediaPayload: Record<string, unknown> = {};
      if (message.payload && typeof message.payload === "object") {
        const p = message.payload as { mediaId?: string; mediaLink?: string };
        if (p.mediaId) mediaPayload.id = p.mediaId;
        else if (p.mediaLink) mediaPayload.link = p.mediaLink;
      }
      if (message.caption && mediaType !== "audio") mediaPayload.caption = message.caption;
      if (mediaType === "document" && message.mediaFilename) mediaPayload.filename = message.mediaFilename;
      return { ...base, type: mediaType, [mediaType]: mediaPayload };
    }

    case "TEMPLATE": {
      const stored = message.payload as StoredTemplateContent | null;
      if (!stored?.name || !stored?.language) {
        throw new OutboundHandlerError("PARSE_ERROR", "Template message payload missing name or language");
      }
      return {
        ...base,
        type: "template",
        template: {
          name: stored.name,
          language: { code: stored.language },
          ...(stored.components?.length ? { components: stored.components } : {}),
        },
      };
    }

    case "INTERACTIVE": {
      if (!message.payload || typeof message.payload !== "object") {
        throw new OutboundHandlerError("PARSE_ERROR", "Flow message missing payload in Message row");
      }
      const p = message.payload as { flowId?: string; cta?: string; flowToken?: string };
      if (!p.flowId || !p.cta) {
        throw new OutboundHandlerError("PARSE_ERROR", "Flow message payload missing flowId or cta");
      }
      const flowLaunch = await prisma.flowLaunch.findUnique({
        where: { messageId },
        select: { tokenHash: true, flowVersion: { select: { status: true } } },
      });

      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "flow",
          body: { text: message.text ?? "" },
          ...(message.caption ? { footer: { text: message.caption } } : {}),
          action: {
            name: "flow",
            parameters: {
              flow_message_version: "3",
              flow_token: flowLaunch?.tokenHash ?? p.flowToken ?? "unknown",
              flow_id: p.flowId,
              flow_cta: p.cta,
              flow_action: "data_exchange",
              mode: flowLaunch?.flowVersion?.status === "PUBLISHED" ? "published" : "draft",
            },
          },
        },
      };
    }

    default:
      throw new OutboundHandlerError("CLIENT_ERROR", `Unsupported message type: ${message.type}`);
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleOutboundMessage(
  payload: OutboundMessageJobPayload,
  dependencies: OutboundHandlerDependencies = {}
): Promise<OutboundSendResult> {
  const graphFetch = dependencies.graphFetch ?? defaultGraphFetch;
  const { conversationId, messageId } = payload.ref;
  const { tenantId, wabaAccountId, phoneNumberId } = payload.ref;

  // 1. Load message + conversation in one query.
  const row = await prisma.message.findUnique({
    where: { id: messageId },
    include: {
      conversation: {
        select: {
          id: true,
          contactId: true,
          status: true,
          contact: { select: { waId: true } },
          phoneNumber: {
            include: { wabaAccount: { select: { id: true, tenantId: true, metaWabaId: true, name: true, metaAppId: true, accessTokenEnc: true, appSecret: true, apiVersion: true, webhookVerifyToken: true, createdAt: true, updatedAt: true } } },
          },
        },
      },
    },
  });

  if (!row) {
    throw new OutboundHandlerError("NOT_FOUND", `Message not found: ${messageId}`);
  }
  if (row.tenantId !== tenantId) {
    throw new OutboundHandlerError("CLIENT_ERROR", "Tenant mismatch in outbound job");
  }
  if (row.conversation?.phoneNumber?.wabaAccount?.id !== wabaAccountId) {
    throw new OutboundHandlerError("CLIENT_ERROR", "WABA account mismatch in outbound job");
  }
  if (row.conversation?.phoneNumber?.id !== phoneNumberId) {
    throw new OutboundHandlerError("CLIENT_ERROR", "Phone number mismatch in outbound job");
  }

  // 2. Terminal-state shortcut: skip if Message is already in a terminal state.
  //    The OutboxEvent may re-enqueue, but the Message status is the canonical
  //    record. If SENT or FAILED, skip. If PENDING (or anything else), proceed.
  if (row.status === "SENT" || row.status === "DELIVERED" || row.status === "READ") {
    return {
      status: "skipped",
      messageId,
      reason: "ALREADY_SENT",
      existingState: row.status,
    };
  }
  if (row.status === "FAILED") {
    return {
      status: "skipped",
      messageId,
      reason: "ALREADY_FAILED",
      existingState: row.status,
    };
  }

  if (!row.conversation?.phoneNumber) {
    throw new OutboundHandlerError("CLIENT_ERROR", "Conversation has no authorized sender phone number");
  }
  const cfg = phoneNumberConfig(row.conversation.phoneNumber as unknown as OwnedPhoneNumber);
  if (!cfg.phoneNumberId) {
    throw new OutboundHandlerError("CLIENT_ERROR", "WhatsApp is not connected");
  }
  const to = row.conversation.contact.waId;

  // 3. ATOMIC CLAIM. This is the durable execution ownership guarantee.
  //    Inside a transaction so the attempt row and its initial state are
  //    consistent.
  const claim = await prisma.$transaction(async (tx) => {
    await getOrCreateOutboundAttempt(tx, { messageId, tenantId });
    return claimOutboundAttempt(tx, {
      messageId,
      tenantId,
      ownerId: OWNER_ID,
      leaseMs: 60_000,
    });
  });

  if (!claim.claimed) {
    // Another worker is processing this message, or it's in a terminal state.
    return {
      status: "skipped",
      messageId,
      reason: terminalReasonForState(claim.existingState),
      existingState: claim.existingState ?? "UNKNOWN",
    };
  }

  const attempt = claim.attempt!;
  const started = await markOutboundMetaRequestStarted(prisma, {
    attemptId: attempt.id,
    ownerId: OWNER_ID,
  });
  if (!started) {
    return {
      status: "skipped",
      messageId,
      reason: "ALREADY_CLAIMED",
      existingState: "CLAIMED",
    };
  }

  // We have durably crossed the Meta send boundary. Call Meta.
  const apiPayload = await buildPayloadFromMessage(messageId, row, to);

  try {
    const res = await graphFetch<{ messages: { id: string }[] }>({
      method: "POST",
      path: `/${cfg.phoneNumberId}/messages`,
      body: apiPayload,
      related: { type: "message", id: messageId },
      config: cfg,
      diagnostics: {
        tenantId,
        wabaId: wabaAccountId,
        phoneNumberId,
        attemptId: attempt.id,
        jobId: messageId,
        attemptNumber: attempt.attemptCount,
      },
    });

    const waMessageId = res.messages?.[0]?.id;
    if (!waMessageId) {
      throw new MetaResponseError("MISSING_MESSAGE_ID", "Meta returned 200 but no message ID in response", res);
    }

    // Mark SENT, update conversation, and persist canonical events in one transaction.
    const [updated] = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const updatedMsg = await tx.message.update({
        where: { id: messageId },
        data: { status: "SENT", waMessageId },
      });
      await markOutboundSent(tx, { attemptId: attempt.id, waMessageId });
      const conversation = await tx.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: now, lastPreview: (row.text ?? "").slice(0, 140), status: "OPEN" },
      });
      await addCanonicalEvent(tx, buildOutboundMessageStatusChangedEvent({
        tenantId,
        conversationId,
        messageId,
        phoneNumberId,
        wabaAccountId,
        providerMessageId: waMessageId,
        previousStatus: row.status,
        status: "SENT",
        occurredAt: now,
      }));
      const conversationEvent = buildConversationStatusChangedEvent({
        tenantId,
        conversationId,
        contactId: conversation.contactId,
        phoneNumberId,
        wabaAccountId,
        previousStatus: row.conversation.status,
        status: conversation.status,
        occurredAt: now,
      });
      if (conversationEvent) await addCanonicalEvent(tx, conversationEvent);
      return [updatedMsg];
    });

    publish(
      { type: "message:new", payload: { conversationId, message: serializeMessage(updated) } },
      tenantId
    );

    return {
      status: "success",
      waMessageId,
      messageId,
      tenantId,
      conversationId,
      attemptId: attempt.id,
    };
  } catch (err) {
    return await recordFailure(err, attempt, messageId, tenantId, conversationId, phoneNumberId, wabaAccountId, row.status);
  }
}

// ---------------------------------------------------------------------------
// Failure classification and recording
// ---------------------------------------------------------------------------

export class MetaResponseError extends Error {
  constructor(
    public readonly classification: "MISSING_MESSAGE_ID" | "PARSE_ERROR",
    message: string,
    public readonly rawResponse?: unknown
  ) {
    super(message);
    this.name = "MetaResponseError";
  }
}

export interface FailureClassification {
  result: "failed" | "uncertain";
  errorCode: OutboundErrorCode;
  retryable: boolean;
  metaStatus?: number;
  message: string;
}

export function classifyError(err: unknown): FailureClassification {
  const errorMessage = err instanceof Error ? err.message : String(err);

  if (err instanceof MetaResponseError) {
    return {
      result: "uncertain",
      errorCode: err.classification,
      retryable: false,
      message: errorMessage,
    };
  }

  if (err instanceof WhatsAppApiError) {
    // 401/403 — auth failure, certain failure, no retry
    if (err.status === 401 || err.status === 403) {
      return { result: "failed", errorCode: "AUTH_ERROR", retryable: false, metaStatus: err.status, message: errorMessage };
    }
    // 400/404 — validation, certain failure, no retry
    if (err.status === 400 || err.status === 404) {
      return { result: "failed", errorCode: "CLIENT_ERROR", retryable: false, metaStatus: err.status, message: errorMessage };
    }
    // 429 — rate limit: UNCERTAIN (Meta may have accepted the request)
    if (err.status === 429) {
      return { result: "uncertain", errorCode: "META_RATE_LIMIT", retryable: false, metaStatus: err.status, message: errorMessage };
    }
    // 5xx — server error: UNCERTAIN
    if (err.status >= 500) {
      return { result: "uncertain", errorCode: "META_SERVER_ERROR", retryable: false, metaStatus: err.status, message: errorMessage };
    }
    // Other 4xx — treat as certain failure
    return { result: "failed", errorCode: "CLIENT_ERROR", retryable: false, metaStatus: err.status, message: errorMessage };
  }

  // Network-level timeout (fetch throws without a status)
  if (err instanceof Error && (err.name === "TimeoutError" || /timeout|ECONNREFUSED|ENOTFOUND/i.test(err.message))) {
    return { result: "uncertain", errorCode: "TIMEOUT", retryable: false, message: errorMessage };
  }

  // Anything else — parse / unexpected
  return { result: "uncertain", errorCode: "PARSE_ERROR", retryable: false, message: errorMessage };
}

async function recordFailure(
  err: unknown,
  attempt: OutboundAttemptRecord,
  messageId: string,
  tenantId: string,
  conversationId: string,
  phoneNumberId: string,
  wabaAccountId: string,
  previousStatus: "PENDING" | "SENT" | "DELIVERED" | "READ" | "FAILED" | "RECEIVED",
): Promise<OutboundSendFailed | OutboundSendUncertain> {
  const cls = classifyError(err);

  if (cls.result === "failed") {
    const updated = await prisma.$transaction(async (tx) => {
      const updatedMsg = await tx.message.update({
        where: { id: messageId },
        data: { status: "FAILED", errorJson: { code: cls.errorCode, message: cls.message, metaStatus: cls.metaStatus } },
      });
      await markOutboundFailed(tx, {
        attemptId: attempt.id,
        errorCode: cls.errorCode,
        errorMessage: cls.message,
        retryable: cls.retryable,
        metaStatus: cls.metaStatus,
      });
      await addCanonicalEvent(tx, buildOutboundMessageStatusChangedEvent({
        tenantId,
        conversationId,
        messageId,
        phoneNumberId,
        wabaAccountId,
        previousStatus,
        status: "FAILED",
        occurredAt: new Date(),
      }));
      return updatedMsg;
    });
    publish(
      { type: "message:new", payload: { conversationId, message: serializeMessage(updated) } },
      tenantId
    );
    return { status: "failed", messageId, attemptId: attempt.id, errorCode: cls.errorCode, errorMessage: cls.message, retryable: cls.retryable };
  }

  // UNCERTAIN — the message stays PENDING and the attempt is locked as UNCERTAIN.
  // No automatic retry. The job completes successfully from BullMQ's perspective.
  const updated = await prisma.$transaction(async (tx) => {
    const updatedMsg = await tx.message.update({
      where: { id: messageId },
      data: { errorJson: { code: cls.errorCode, message: cls.message, uncertain: true, metaStatus: cls.metaStatus } },
    });
    await markOutboundUncertain(tx, {
      attemptId: attempt.id,
      errorCode: cls.errorCode,
      errorMessage: cls.message,
      metaStatus: cls.metaStatus,
    });
    return updatedMsg;
  });
  publish(
    { type: "message:new", payload: { conversationId, message: serializeMessage(updated) } },
    tenantId
  );
  return { status: "uncertain", messageId, attemptId: attempt.id, errorCode: cls.errorCode, errorMessage: cls.message };
}

function terminalReasonForState(state: string | null): OutboundSendSkipped["reason"] {
  switch (state) {
    case "SENT":
      return "ALREADY_SENT";
    case "FAILED":
      return "ALREADY_FAILED";
    case "UNCERTAIN":
      return "ALREADY_UNCERTAIN";
    case "CLAIMED":
      return "ALREADY_CLAIMED";
    default:
      return "TERMINAL_STATE";
  }
}
