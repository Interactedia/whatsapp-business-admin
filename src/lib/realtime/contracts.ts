/**
 * WA-ERA4-04 — Internal contract validators.
 *
 * Provides additional validation ON TOP of the existing decodeEnvelope
 * in distribution.ts. These validators:
 *  - Reject envelopes whose scope contradicts the event's known scope
 *  - Reject envelopes with malformed payload shape for known event types
 *  - Reject envelopes where global scope is used to deliver tenant payloads
 *
 * The validators are INTENTIONALLY permissive for unknown event types:
 * the wire contract is open. Strengthening here is additive: known events
 * get tighter checks, unknown events pass through as before.
 *
 * The validators NEVER change the public RealtimeEvent shape or
 * introduce new required wire fields.
 */
import type { RealtimeEvent, RealtimeEnvelope } from "@/lib/realtime/distribution";
import {
  isRealtimeEvent,
  scopeForEventType,
  type KnownEventType,
} from "@/lib/realtime/events";

export type ValidationFailure = {
  reason: string;
  field?: string;
};

/**
 * Validate an envelope for SCOPE safety. The known scope is derived from
 * the event type. A mismatch (e.g. a tenant event delivered with a null
 * tenant) is rejected.
 *
 * Returns null on success, a ValidationFailure on rejection.
 */
export function validateEnvelopeScope(env: RealtimeEnvelope): ValidationFailure | null {
  if (!env || typeof env !== "object") {
    return { reason: "envelope_not_object" };
  }
  if (typeof env.origin !== "string" || env.origin.length === 0) {
    return { reason: "origin_invalid" };
  }
  if (env.tenantId !== null && typeof env.tenantId !== "string") {
    return { reason: "tenantId_invalid" };
  }
  if (!isRealtimeEvent(env.event)) {
    return { reason: "event_invalid" };
  }

  const knownScope = scopeForEventType(env.event.type);
  if (knownScope === null) {
    // Unknown event — open wire contract. Accept.
    return null;
  }
  if (knownScope === "tenant" && env.tenantId === null) {
    return {
      reason: "tenant_event_with_null_tenant",
      field: "tenantId",
    };
  }
  if (knownScope === "global" && env.tenantId !== null) {
    return {
      reason: "global_event_with_tenant",
      field: "tenantId",
    };
  }
  return null;
}

/**
 * Validate the payload shape for a known event type. Returns null on
 * success. For unknown types, returns null (open contract).
 *
 * The check is SHAPE-only: required string keys, optional keys, and the
 * expected high-level structure. It does NOT validate inner object shapes
 * (e.g. the `message` field is left as unknown — that is the producer's
 * domain).
 */
export function validatePayloadShape(event: RealtimeEvent): ValidationFailure | null {
  if (!isRealtimeEvent(event)) {
    return { reason: "event_not_object" };
  }
  const payload = event.payload;
  if (payload === undefined) {
    return { reason: "payload_missing" };
  }
  if (!payload || typeof payload !== "object") {
    return { reason: "payload_not_object" };
  }
  const p = payload as Record<string, unknown>;
  switch (event.type as KnownEventType) {
    case "message:new":
      return requireKeys(p, [
        { key: "conversationId", kind: "string" },
        { key: "message", kind: "object" },
      ]);
    case "message:status":
      return requireKeys(p, [
        { key: "conversationId", kind: "string" },
        { key: "waMessageId", kind: "string" },
        { key: "status", kind: "string" },
      ]);
    case "message:image-enriched":
      return requireKeys(p, [
        { key: "messageId", kind: "string" },
        { key: "conversationId", kind: "string" },
        { key: "enrichment", kind: "object" },
      ]);
    case "flow:submission":
      return requireKeys(p, [
        { key: "conversationId", kind: "string" },
        { key: "submissionId", kind: "string" },
        { key: "launchId", kind: "string" },
      ]);
    case "conversation:updated":
      return requireKeys(p, [
        { key: "conversationId", kind: "string" },
      ]);
    case "template:status":
      return requireKeys(p, [
        { key: "id", kind: "string" },
        { key: "status", kind: "string" },
      ]);
    default:
      return null;
  }
}

type KeySpec = { key: string; kind: "string" | "object" };

function requireKeys(
  obj: Record<string, unknown>,
  keys: readonly KeySpec[],
): ValidationFailure | null {
  for (const { key, kind } of keys) {
    const v = obj[key];
    if (v === undefined || v === null) {
      return { reason: "payload_key_invalid", field: key };
    }
    if (kind === "string") {
      if (typeof v !== "string" || v.length === 0) {
        return { reason: "payload_key_invalid", field: key };
      }
    } else {
      if (typeof v !== "object") {
        return { reason: "payload_key_invalid", field: key };
      }
    }
  }
  return null;
}

/**
 * Combined validator: scope + payload shape. Returns the first failure
 * or null.
 */
export function validateEnvelope(env: RealtimeEnvelope): ValidationFailure | null {
  const scope = validateEnvelopeScope(env);
  if (scope) return scope;
  return validatePayloadShape(env.event);
}
