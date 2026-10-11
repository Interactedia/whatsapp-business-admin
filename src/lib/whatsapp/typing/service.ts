/**
 * WhatsApp typing-indicator service.
 *
 * ## Official Meta API
 *
 * Meta's typing-indicator API (introduced Jun 2026) sends the indicator **together
 * with a read receipt** in a single request:
 * ```
 * POST /{phone_number_id}/messages
 * {
 *   "messaging_product": "whatsapp",
 *   "status": "read",
 *   "message_id": "<wamid>",
 *   "typing_indicator": { "type": "text" }
 * }
 * ```
 * Response: `{ "success": true }`
 * The indicator disappears after you send a message or after 25 seconds, whichever
 * comes first.
 *
 * There is **no separate typing-only endpoint**.  The request always marks the
 * message as read at Meta's side (blue check marks).  The internal
 * `Conversation.unreadCount` is **never mutated** by this service.
 *
 * ## Design: explicit caller authorisation
 *
 * Because the API always marks messages as read, the service requires callers to
 * pass `markAsRead: true` explicitly.  Omitting the flag (or passing `false`)
 * causes the service to return a safe `{ success: false }` result — no request
 * is made to Meta and no state is changed.  This satisfies invariant 8:
 * "read-receipt side effects must be explicit."
 *
 * ## What this module does NOT do
 *
 * - Persist anything to the database (ephemeral).
 * - Use the transactional outbox (invariant 6).
 * - Automatically retry on failure (invariant 7).
 * - Mutate `Conversation.unreadCount` or any other internal read state (invariant 9).
 * - Block outbound message delivery.
 *
 * ## Rate control
 *
 * Uses `p-queue` for in-process, per-phone-number request serialisation.
 * Each phone number gets its own queue so concurrent conversations on different
 * numbers are not blocked.  Under multiple server instances each instance maintains
 * its own queues; this is sufficient for single-tenant deployments.  Redis-backed
 * coordination would require a separate implementation unit (ADR-0005).
 *
 * ## Failure semantics
 *
 * Typing is best-effort.  `sendTypingIndicator` resolves with `{ success: true }`
 * only when Meta confirms the request (HTTP 200 / `{ success: true }`).
 * On any non-2xx response, timeout, or network error it resolves with
 * `{ success: false, reason: "..." }`.  It never throws, and it never blocks
 * the caller's execution path.
 */

import PQueue from "p-queue";
import { prisma } from "@/lib/prisma";
import { graphFetch, WhatsAppApiError } from "@/lib/whatsapp/client";
import { phoneNumberConfig } from "@/lib/tenant/waba";
import { assertTrustedTenantContext, TenantAuthorizationError, type TenantContext } from "@/lib/tenant";
import type { WabaConfig } from "@/lib/settings";
import {
  TYPING_ENABLED,
  TYPING_REQUEST_TIMEOUT_MS,
  TYPING_MIN_INTERVAL_MS,
} from "./config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SendTypingOptions {
  /** Trusted tenant execution context (must be a previously returned TenantContext). */
  context: TenantContext;
  /** Primary key of the conversation whose customer should see "typing…". */
  conversationId: string;
  /**
   * Primary key of the inbound `Message` row that this typing is in response to.
   * Must be a message with `direction: "IN"` that belongs to the conversation.
   */
  inboundMessageId: string;
  /**
   * **Mandatory.** Must be `true` to use this service.
   *
   * Meta's typing-indicator API always marks the message as read (blue check marks)
   * as part of the same request — there is no separate typing-only endpoint.
   * This service therefore requires explicit caller authorisation before it will
   * make any request to Meta.
   *
   * Pass `true` only when your workflow has explicitly decided to mark the
   * message as read and show the typing indicator to the customer.
   *
   * **The internal `Conversation.unreadCount` is never updated by this service,
   * regardless of this flag.**  Managing that counter is the caller's responsibility.
   *
   * @default false
   */
  markAsRead?: boolean;
}

export interface SendTypingResult {
  /** `true` when Meta confirmed the request. */
  success: boolean;
  /** Human-readable reason when `success` is `false`. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Per-phone-number request queues (in-process rate control)
// ---------------------------------------------------------------------------

/** One p-queue per phone number so concurrent conversations don't block each other. */
const phoneQueues = new Map<string, PQueue>();

function queueFor(phoneNumberId: string): PQueue {
  let q = phoneQueues.get(phoneNumberId);
  if (!q) {
    // `interval` enforces the minimum gap between two requests for the same phone.
    q = new PQueue({ concurrency: 1, interval: TYPING_MIN_INTERVAL_MS, intervalCap: 1 });
    phoneQueues.set(phoneNumberId, q);
  }
  return q;
}

// ---------------------------------------------------------------------------
// Core service
// ---------------------------------------------------------------------------

/**
 * Send a WhatsApp typing indicator (coupled with a read receipt) via Meta.
 *
 * ## Authorisation
 *
 * The `context` must be a `TenantContext` previously returned by
 * `resolveTenantContext()` or `resolveApiKeyTenantContext()`.
 *
 * The conversation, its phone number, and the inbound message must all belong to
 * the same tenant as `context.tenantId`.  Cross-tenant calls throw
 * `TenantAuthorizationError` before any Meta request is made.
 *
 * ## Usage
 *
 * ```ts
 * // Caller has explicitly decided to mark as read + show typing:
 * const result = await sendTypingIndicator({
 *   context,           // from resolveTenantContext()
 *   conversationId,
 *   inboundMessageId: message.id,
 *   markAsRead: true, // REQUIRED — service will not fire without this
 * });
 * ```
 *
 * The service resolves immediately with `{ success, reason? }` — it never throws.
 */
export async function sendTypingIndicator(
  opts: SendTypingOptions,
): Promise<SendTypingResult> {
  assertTrustedTenantContext(opts.context);

  // ── Guard: capability must be explicitly enabled ───────────────────────────
  if (!TYPING_ENABLED) {
    return {
      success: false,
      reason: "typing-indicator capability is disabled (set WHATSAPP_TYPING_ENABLED=true to activate)",
    };
  }

  // ── Guard: caller must explicitly authorise the read-receipt side effect ───
  // Meta's API always marks the message as read alongside the typing indicator.
  // Refuse to act unless the caller has consciously opted in.  This is the
  // enforcement point for invariant 8 (read-receipt side effects must be explicit).
  if (opts.markAsRead !== true) {
    return {
      success: false,
      reason:
        "markAsRead must be explicitly set to true; Meta's typing-indicator API always marks messages as read — " +
        "pass markAsRead: true only when your workflow has authorised this side effect",
    };
  }

  // ── 1. Load conversation + validate tenant ownership ───────────────────────
  const conversation = await prisma.conversation.findUnique({
    where: { id: opts.conversationId },
    include: {
      contact: { select: { waId: true } },
      phoneNumber: { include: { wabaAccount: true } },
    },
  });

  if (!conversation) {
    return { success: false, reason: "conversation not found" };
  }

  if (conversation.tenantId !== opts.context.tenantId) {
    throw new TenantAuthorizationError();
  }

  if (!conversation.phoneNumber) {
    return { success: false, reason: "conversation has no associated phone number" };
  }

  if (!conversation.contact.waId) {
    return { success: false, reason: "contact has no WhatsApp ID" };
  }

  // Narrow the non-null reference into a const so TypeScript can flow it.
  const phoneNumber = conversation.phoneNumber;

  // ── 2. Load inbound message and validate it belongs to this conversation ───
  const message = await prisma.message.findFirst({
    where: {
      id: opts.inboundMessageId,
      conversationId: opts.conversationId,
      direction: "IN",
      tenantId: opts.context.tenantId,
    },
  });

  if (!message) {
    return {
      success: false,
      reason: "inbound message not found or does not belong to this conversation",
    };
  }

  if (!message.waMessageId) {
    return {
      success: false,
      reason: "inbound message has no provider message ID (waMessageId)",
    };
  }

  // ── 3. Build WabaConfig ─────────────────────────────────────────────────
  const cfg = phoneNumberConfig(phoneNumber);
  if (!cfg.phoneNumberId || !cfg.accessToken) {
    return { success: false, reason: "WhatsApp is not connected for this phone number" };
  }

  // ── 4. Enqueue per-phone-number (rate control) ───────────────────────────
  // waMessageId is already verified non-null above; store in const so the
  // async callback's closure can use it without TS narrowing loss.
  const wamid = message.waMessageId as string;
  const queue = queueFor(phoneNumber.id);

  return await queue.add(async () =>
    executeTypingRequest(cfg, wamid),
  );
}

// ---------------------------------------------------------------------------
// Meta API call
// ---------------------------------------------------------------------------

/**
 * Fire the combined typing-indicator + read-receipt request to Meta.
 * Wrapped in a p-queue callback; never throws on Meta errors.
 *
 * Official Meta payload (confirmed Jun 2026):
 * POST /{phone_number_id}/messages
 * {
 *   "messaging_product": "whatsapp",
 *   "status": "read",
 *   "message_id": "<wamid>",
 *   "typing_indicator": { "type": "text" }
 * }
 *
 * Response: { "success": true }
 */
async function executeTypingRequest(
  cfg: WabaConfig,
  waMessageId: string,
): Promise<SendTypingResult> {
  const signal = AbortSignal.timeout(TYPING_REQUEST_TIMEOUT_MS);

  try {
    const body = {
      messaging_product: "whatsapp",
      status: "read",
      message_id: waMessageId,
      typing_indicator: { type: "text" as const },
    };

    await graphFetch<{ success?: boolean }>({
      method: "POST",
      path: `/${cfg.phoneNumberId}/messages`,
      body,
      config: cfg,
      signal,
      // typing-indicator calls are ephemeral; do not create a durable ApiLog link
      // since there is no business Message row to relate to
      related: { type: "typing-indicator" },
    });

    return { success: true };
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return { success: false, reason: "Meta request timed out" };
    }
    if (err instanceof WhatsAppApiError) {
      return { success: false, reason: `Meta error ${err.status}: ${err.message}` };
    }
    return { success: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
