import type { WebhookAuthRejectionReason } from "./auth";

/**
 * Bounded, structured diagnostics for `WebhookEvent.error`.
 *
 * The column is a single TEXT field, so diagnostics are serialized as a small
 * fixed-shape JSON object. The goal is narrow: let an operator identify WHERE
 * processing failed and WHY, from the logs screen, without ever persisting an
 * App Secret, an access token, signature material, or request-body content.
 *
 * Every value is length-capped and the total is capped, so a hostile or
 * malformed upstream error message cannot inflate stored rows.
 */

/** Pipeline stage that produced the failure. */
export type WebhookFailureStage =
  | "webhook.authentication"
  | "inbound.processing"
  | "status.processing";

/** Coarse error class. Stable enough to filter on, generic enough to be safe. */
export type WebhookFailureCategory =
  | "AUTH_REJECTED"
  | "TENANT_UNRESOLVED"
  | "VALIDATION"
  | "DUPLICATE"
  | "UPSTREAM"
  | "INTERNAL";

export interface WebhookErrorDiagnostic {
  stage: WebhookFailureStage;
  category: WebhookFailureCategory;
  reason: string;
  /** Validation field or header at fault, when applicable. */
  field?: string;
  /** Correlates the diagnostic with its `WebhookEvent` row. */
  correlationId?: string;
}

const MAX_FIELD_LENGTH = 160;
const MAX_TOTAL_LENGTH = 1024;
const REDACTED = "[REDACTED]";

/**
 * Credential-shaped material that must never reach `WebhookEvent.error`.
 *
 * The only untrusted string that gets here is an upstream error message, and
 * provider error text can echo request fragments — including an access token.
 * Rather than dropping the whole diagnostic (which would make the row useless
 * for triage), matching spans are redacted in place.
 *
 * ponytail: regex scrubbing, not a real DLP pass. Adequate because secrets
 * live in separate config objects that are never formatted into these values;
 * this only has to catch an accidental echo in free-form provider text.
 */
const CREDENTIAL_PATTERN =
  /\b(?:app[_-]?secret|access[_-]?token|accessTokenEnc|password|credential|secret|bearer|authorization|private[_-]?key)\b\s*[:=]?\s*(?:bearer\s+)?\S+|sha256=[0-9a-fA-F]+/gi;

/** Redact credential-shaped spans, flatten whitespace, and cap the length. */
function scrub(value: string): string {
  const redacted = value.replace(CREDENTIAL_PATTERN, REDACTED);
  const oneLine = redacted.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_FIELD_LENGTH ? `${oneLine.slice(0, MAX_FIELD_LENGTH)}…` : oneLine;
}

function cap(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_FIELD_LENGTH ? `${oneLine.slice(0, MAX_FIELD_LENGTH)}…` : oneLine;
}

/**
 * Screen a free-form detail string. Returns `undefined` when nothing safe
 * remains, so the field is omitted rather than stored empty.
 */
function sanitizeDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const cleaned = scrub(detail);
  // A detail reduced to nothing but the redaction marker carries no signal.
  if (cleaned.length === 0 || cleaned === REDACTED) return undefined;
  return cleaned;
}

/** Serialize a diagnostic for `WebhookEvent.error`. Never throws. */
export function formatWebhookError(diagnostic: WebhookErrorDiagnostic): string {
  const record: Record<string, string> = {
    stage: diagnostic.stage,
    category: diagnostic.category,
    reason: scrub(diagnostic.reason),
  };
  const field = sanitizeDetail(diagnostic.field);
  if (field) record.field = field;
  if (diagnostic.correlationId) record.correlationId = cap(diagnostic.correlationId);

  let serialized = JSON.stringify(record);
  if (serialized.length > MAX_TOTAL_LENGTH) {
    // Drop the least-essential field first, then hard-truncate as a backstop.
    delete record.reason;
    serialized = JSON.stringify(record);
    if (serialized.length > MAX_TOTAL_LENGTH) serialized = serialized.slice(0, MAX_TOTAL_LENGTH);
  }
  return serialized;
}

/** Authentication was refused; nothing downstream ran. */
export function authRejectionDiagnostic(
  reason: WebhookAuthRejectionReason,
  correlationId?: string,
): WebhookErrorDiagnostic {
  return {
    stage: "webhook.authentication",
    category: "AUTH_REJECTED",
    reason: reason,
    // The header is the thing being judged; never its value.
    field: reason === "APP_SECRET_UNCONFIGURED" ? undefined : "x-hub-signature-256",
    correlationId,
  };
}

/**
 * Map a thrown error onto a diagnostic.
 *
 * Recognises the canonical event validation error so a rejected `wamid` (or
 * any other envelope violation) reports the offending field instead of an
 * opaque "processing error". Falls back to a generic category for everything
 * else — the raw message is capped and screened, never assumed safe.
 */
export function processingErrorDiagnostic(
  stage: WebhookFailureStage,
  error: unknown,
  correlationId?: string,
): WebhookErrorDiagnostic {
  const message = error instanceof Error ? error.message : String(error);

  if (isValidationFailure(error)) {
    return {
      stage,
      category: "VALIDATION",
      reason: String(error.code),
      field: firstDetail(error.details),
      correlationId,
    };
  }

  if (isDuplicateDelivery(error)) {
    return { stage, category: "DUPLICATE", reason: cap(message), correlationId };
  }

  if (isTenantResolutionFailure(message)) {
    return { stage, category: "TENANT_UNRESOLVED", reason: cap(message), correlationId };
  }

  return { stage, category: "INTERNAL", reason: cap(message), correlationId };
}

/** Short human label for `eventSummary` when a webhook was rejected. */
export function rejectionSummary(reason: WebhookAuthRejectionReason): string {
  return `rejected: ${reason.toLowerCase().replace(/_/g, " ")}`;
}

function firstDetail(details: unknown): string | undefined {
  if (!Array.isArray(details) || details.length === 0) return undefined;
  const first = details[0];
  return typeof first === "string" ? first : undefined;
}

/** Structural check — avoids importing the event contract into this module. */
function isValidationFailure(error: unknown): error is { code: string; details?: unknown } {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "ExternalEventValidationError" &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

function isDuplicateDelivery(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

function isTenantResolutionFailure(message: string): boolean {
  return message.includes("Unable to resolve inbound phone number") || message.includes("tenant mismatch");
}
