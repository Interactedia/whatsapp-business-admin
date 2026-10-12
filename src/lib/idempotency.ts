import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ApiError, apiOk } from "@/lib/v1";

/**
 * External client idempotency for POST /api/v1/messages (WA-REMEDIATION-1A).
 *
 * Callers may send an `Idempotency-Key` header. The key is bound atomically to
 * the logical outbound Message row (#tenant-scoped unique index), so:
 *   - a repeated equivalent request returns the original outbound identity and
 *     never creates a second message, queue job or provider transmission;
 *   - the same key with a different payload is a deterministic 409 conflict;
 *   - a concurrent duplicate loses the unique-constraint race and is resolved
 *     to the same duplicate/conflict response.
 *
 * The key is deliberately *not* the BullMQ job identity. Job identity only
 * protects the outbound worker; external idempotency must survive HTTP retries
 * and process restarts, so it lives in PostgreSQL with the message.
 */

/** Standard external idempotency header for POST /api/v1/messages. */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/** Maximum accepted key length (bounds the unique index and fingerprint cost). */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/** URL-safe, printable, no whitespace/control characters. */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:\-]+$/;

/** Reject malformed keys explicitly; absent header → null (legacy behavior). */
export function parseIdempotencyKey(req: Request): string | null {
  const raw = req.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (raw === null) return null;
  const key = raw.trim();
  if (key.length === 0) {
    throw new ApiError(400, "Idempotency-Key must not be empty.");
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new ApiError(400, `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`);
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ApiError(
      400,
      "Idempotency-Key must contain only ASCII letters, digits, dot, dash, underscore or colon.",
    );
  }
  return key;
}

/**
 * Deterministic JSON for fingerprinting: object keys are sorted recursively and
 * `undefined` values are dropped, so field order in the incoming payload cannot
 * change the fingerprint. Arrays keep their order (order is material).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
}

/**
 * Material fields that can change the outbound operation. Transport/auth
 * metadata (`apikey`) and server-generated values (flow tokens) are excluded —
 * they must not perturb the fingerprint.
 */
export type IdempotencyFingerprintInput = {
  tenantId: string;
  phoneNumberId: string; // channel / WABA account
  conversationId: string; // conversation + recipient binding
  to: string; // recipient
  type: string; // resolved message type
  text?: string;
  media?: unknown;
  template?: string;
  language?: string;
  variables?: unknown;
  body_variables?: unknown;
  header_text?: string;
  header_media?: unknown;
  buttons?: unknown;
  components?: unknown;
  flow_data?: unknown;
};

/**
 * Canonical request fingerprint. Deterministic across restarts: the same inputs
 * always hash to the same value regardless of process or object key order.
 */
export function computeIdempotencyFingerprint(input: IdempotencyFingerprintInput): string {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(input))).digest("hex");
}

/** Values threaded into the persistence layer to bind a key to a message row. */
export type IdempotencyKeyBinding = {
  idempotencyKey?: string;
  idempotencyFingerprint?: string;
};

/** The message that already owns this tenant-scoped external key, if any. */
export async function findIdempotentMessage(tenantId: string, idempotencyKey: string) {
  return prisma.message.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
    select: { id: true, status: true, waMessageId: true, idempotencyFingerprint: true },
  });
}

/** Prisma P2002 (unique constraint) — the concurrent-duplicate race signal. */
export function isIdempotencyUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function conflictResponse(message: string): Response {
  return NextResponse.json(
    { status: "error", code: "IDEMPOTENCY_KEY_CONFLICT", message },
    { status: 409 },
  );
}

/**
 * Stable response for an Idempotency-Key that already owns a message.
 *
 * - equivalent payload → 200 with the original outbound identity. A Meta
 *   acknowledgement is never fabricated: `message_id` is present only when a
 *   wamid was actually persisted.
 * - different payload   → 409 conflict (key reuse with a different request).
 */
export function idempotencyDuplicateResponse(
  existing: {
    id: string;
    status: string;
    waMessageId: string | null;
    idempotencyFingerprint: string | null;
  },
  fingerprint: string,
  to: string,
): Response {
  if (existing.idempotencyFingerprint !== fingerprint) {
    return conflictResponse("Idempotency-Key was already used with a different request payload.");
  }
  return apiOk(
    {
      id: existing.id,
      to,
      duplicate: true,
      message_status: existing.status,
      ...(existing.waMessageId ? { message_id: existing.waMessageId } : {}),
    },
    200,
  );
}

/**
 * Run an outbound dispatch under optional durable idempotency.
 *
 * Fast path: an existing tenant/key returns the original message (or conflict)
 * without dispatching. Otherwise the caller persists the key atomically with
 * the message row; a concurrent duplicate loses the unique-constraint race and
 * is resolved to the same response. Any other database error propagates — we
 * fail closed and never fall back to a non-idempotent send.
 */
export async function runIdempotent(
  ctx: { tenantId: string; key: string | null; fingerprint: string | null; to: string },
  run: () => Promise<Response>,
): Promise<Response> {
  if (!ctx.key || !ctx.fingerprint) return run();

  const existing = await findIdempotentMessage(ctx.tenantId, ctx.key);
  if (existing) return idempotencyDuplicateResponse(existing, ctx.fingerprint, ctx.to);

  try {
    return await run();
  } catch (error) {
    if (!isIdempotencyUniqueViolation(error)) throw error;
    const raced = await findIdempotentMessage(ctx.tenantId, ctx.key);
    if (!raced) throw error;
    return idempotencyDuplicateResponse(raced, ctx.fingerprint, ctx.to);
  }
}
