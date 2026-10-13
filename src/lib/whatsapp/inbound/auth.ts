import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getWabaConfig } from "@/lib/settings";
import { verifySignature } from "@/lib/whatsapp/signature";

/**
 * Meta webhook authentication — fail-closed.
 *
 * This module owns ONE question: "did this request genuinely come from Meta?"
 * It is deliberately separate from WABA/tenant routing: authentication proves
 * origin, routing proves ownership. A webhook that cannot be authenticated
 * must never reach routing, enqueueing, or any business-data mutation.
 *
 * Policy: every externally received Meta webhook is verified with HMAC-SHA256
 * over the UNMODIFIED raw request bytes against an appropriate Meta App Secret.
 * A missing signature, a malformed signature, a mismatching signature, and a
 * deployment with no App Secret configured at all are ALL rejected.
 */

/**
 * Why authentication was refused. Persisted as bounded diagnostics; never
 * contains a secret, a signature value, or request-body content.
 */
export type WebhookAuthRejectionReason =
  /** No `x-hub-signature-256` header was sent. */
  | "SIGNATURE_MISSING"
  /** Header present but not a `sha256=<hex>` value. */
  | "SIGNATURE_MALFORMED"
  /** Signature did not match any configured App Secret. */
  | "SIGNATURE_INVALID"
  /** No App Secret is configured anywhere, so origin cannot be proven. */
  | "APP_SECRET_UNCONFIGURED";

export type MetaWebhookAuthResult =
  | {
      authenticated: true;
      /** Which configured secret verified the body. Never the secret itself. */
      secretSource: "global" | "tenant";
      signatureValid: true;
    }
  | {
      authenticated: false;
      signatureValid: false;
      reason: WebhookAuthRejectionReason;
      /**
       * Whether the body was rejected only because no secret exists to verify
       * it. Kept so callers can log a distinct operator-actionable signal
       * without treating it as permission to continue.
       */
      missingSecret: boolean;
    };

const SIGNATURE_HEADER = "x-hub-signature-256";
/** Meta sends `sha256=<hex>`; bound the accepted shape before any comparison. */
const SIGNATURE_SHAPE = /^sha256=[0-9a-f]{64}$/;

export { SIGNATURE_HEADER };

/**
 * Verify Meta's `X-Hub-Signature-256` over raw request bytes.
 *
 * Uses `crypto.timingSafeEqual` via {@link verifySignature}. The raw string
 * must be the exact bytes received — any re-serialization (JSON round-trip,
 * whitespace normalization) changes the HMAC and breaks verification.
 */
export function isMetaSignatureValid(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
): boolean {
  return verifySignature(rawBody, signatureHeader, appSecret);
}

/** Cheap shape check so a malformed header is rejected before secret work. */
export function hasWellFormedMetaSignature(signatureHeader: string | null): boolean {
  if (!signatureHeader) return false;
  return SIGNATURE_SHAPE.test(signatureHeader.trim().toLowerCase());
}

/**
 * Authenticate an inbound Meta webhook.
 *
 * Secret candidates are resolved from trusted server-side configuration only:
 * the global WABA settings singleton first, then per-tenant WabaAccount
 * secrets. Caller-supplied identifiers are never consulted.
 *
 * ponytail: linear scan over tenant secrets, same as the prior behaviour.
 * Upgrade to a keyed lookup (e.g. by Meta app id from the payload) only if the
 * number of tenant App Secrets makes per-request HMAC work measurable.
 */
export async function authenticateMetaWebhook(
  rawBody: string,
  signatureHeader: string | null,
): Promise<MetaWebhookAuthResult> {
  const candidates = await resolveAppSecretCandidates();

  if (candidates.length === 0) {
    return {
      authenticated: false,
      signatureValid: false,
      reason: "APP_SECRET_UNCONFIGURED",
      missingSecret: true,
    };
  }

  // Fail closed on a missing or malformed header: never attempt to verify,
  // and never fall through to processing.
  if (!signatureHeader) {
    return reject("SIGNATURE_MISSING");
  }
  if (!hasWellFormedMetaSignature(signatureHeader)) {
    return reject("SIGNATURE_MALFORMED");
  }

  for (const candidate of candidates) {
    if (verifySignature(rawBody, signatureHeader, candidate.secret)) {
      return { authenticated: true, secretSource: candidate.source, signatureValid: true };
    }
  }

  return reject("SIGNATURE_INVALID");
}

function reject(reason: Exclude<WebhookAuthRejectionReason, "APP_SECRET_UNCONFIGURED">): MetaWebhookAuthResult {
  return { authenticated: false, signatureValid: false, reason, missingSecret: false };
}

type SecretCandidate = { secret: string; source: "global" | "tenant" };

async function resolveAppSecretCandidates(): Promise<SecretCandidate[]> {
  const candidates: SecretCandidate[] = [];

  const cfg = await getWabaConfig();
  if (cfg.appSecret) candidates.push({ secret: cfg.appSecret, source: "global" });

  const tenantAccounts = await prisma.wabaAccount.findMany({
    where: { appSecret: { not: null } },
    select: { appSecret: true },
  });
  for (const acc of tenantAccounts) {
    if (acc.appSecret) candidates.push({ secret: acc.appSecret, source: "tenant" });
  }

  return candidates;
}

/**
 * Compute a valid `X-Hub-Signature-256` header for a raw body.
 *
 * Test/verification helper only: used to build locally signed fixtures that
 * exercise the real verification path. Never logs the secret.
 */
export function signMetaWebhookBody(rawBody: string, appSecret: string): string {
  return `sha256=${crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`;
}
