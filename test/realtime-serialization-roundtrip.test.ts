/**
 * WA-ERA4-04 — Envelope serialization round-trip tests.
 *
 * Deterministic, no I/O. We exercise the existing encodeEnvelope /
 * decodeEnvelope functions in distribution.ts and the WA-ERA4-04
 * contract validators in contracts.ts to lock in:
 *
 *  - Wire format round-trip: encode -> decode returns the same envelope
 *  - All canonical event types round-trip with correct scope
 *  - Decoding malformed input fails safely (returns null or a validation
 *    failure, never throws, never delivers)
 *  - Scope validators reject envelopes whose tenantId contradicts the
 *    event type's known scope
 *  - Payload shape validators reject missing or empty required keys
 *
 * The real-Redis integration test in test/integration/realtime-fanout.test.ts
 * remains the authoritative proof for cross-process serialization. This
 * file complements that with a deterministic unit-level guarantee.
 */
import { describe, expect, it } from "vitest";
import { decodeEnvelope, encodeEnvelope, type RealtimeEnvelope } from "@/lib/realtime/distribution";
import {
  validateEnvelope,
  validateEnvelopeScope,
  validatePayloadShape,
} from "@/lib/realtime/contracts";
import { ALL_KNOWN_EVENT_TYPES } from "@/lib/realtime/events";

describe("Envelope serialization round-trip", () => {
  it("tenant envelope round-trips losslessly", () => {
    const original: RealtimeEnvelope = {
      origin: "wa-1-abc",
      tenantId: "tenant-a",
      event: {
        type: "message:new",
        payload: {
          conversationId: "c1",
          contactId: "ct1",
          message: { id: "m1", text: "hi" },
        },
      },
    };
    const wire = encodeEnvelope(original);
    const decoded = decodeEnvelope(wire);
    expect(decoded).not.toBeNull();
    expect(decoded).toEqual(original);
  });

  it("global envelope round-trips losslessly", () => {
    const original: RealtimeEnvelope = {
      origin: "wa-1-abc",
      tenantId: null,
      event: { type: "template:status", payload: { id: "tpl-1", status: "APPROVED" } },
    };
    const wire = encodeEnvelope(original);
    const decoded = decodeEnvelope(wire);
    expect(decoded).toEqual(original);
  });

  it.each(ALL_KNOWN_EVENT_TYPES)("event type %s round-trips through encode/decode", (type) => {
    const isTenant = type !== "template:status";
    const envelope: RealtimeEnvelope = {
      origin: "wa-1-abc",
      tenantId: isTenant ? "tenant-a" : null,
      event: { type, payload: representativePayloadFor(type) },
    };
    const wire = encodeEnvelope(envelope);
    const decoded = decodeEnvelope(wire);
    expect(decoded).toEqual(envelope);
  });

  it("rejects invalid JSON at the decode layer", () => {
    expect(decodeEnvelope("not-json{")).toBeNull();
  });

  it("rejects non-object payloads at the decode layer", () => {
    expect(decodeEnvelope("null")).toBeNull();
    expect(decodeEnvelope("42")).toBeNull();
    expect(decodeEnvelope("\"string\"")).toBeNull();
  });

  it("rejects envelopes with empty origin", () => {
    const wire = JSON.stringify({
      origin: "",
      tenantId: null,
      event: { type: "template:status", payload: { id: "t1", status: "X" } },
    });
    expect(decodeEnvelope(wire)).toBeNull();
  });

  it("rejects envelopes with wrong tenantId type", () => {
    const wire = JSON.stringify({
      origin: "wa-1",
      tenantId: 42,
      event: { type: "template:status", payload: { id: "t1", status: "X" } },
    });
    expect(decodeEnvelope(wire)).toBeNull();
  });

  it("rejects envelopes with empty event.type", () => {
    const wire = JSON.stringify({
      origin: "wa-1",
      tenantId: null,
      event: { type: "", payload: {} },
    });
    expect(decodeEnvelope(wire)).toBeNull();
  });

  it("decode never throws on garbage input", () => {
    const inputs = [
      "",
      "{",
      "\u0000",
      "[]",
      "[1,2,3]",
      "{\"a\":1}",
      "null",
      "true",
      "false",
      "0",
      "NaN",
    ];
    for (const input of inputs) {
      expect(() => decodeEnvelope(input)).not.toThrow();
    }
  });
});

describe("Scope validator after round-trip", () => {
  it("accepts a tenant event that was correctly scoped and round-tripped", () => {
    const env: RealtimeEnvelope = {
      origin: "wa-1",
      tenantId: "tenant-a",
      event: { type: "message:new", payload: { conversationId: "c1", message: {} } },
    };
    const decoded = decodeEnvelope(encodeEnvelope(env))!;
    expect(validateEnvelopeScope(decoded)).toBeNull();
  });

  it("rejects a tenant event whose tenantId was lost in transit", () => {
    const wire = JSON.stringify({
      origin: "wa-1",
      tenantId: null,
      event: { type: "message:new", payload: { conversationId: "c1", message: {} } },
    });
    // decodeEnvelope accepts structurally valid envelopes even with the
    // wrong scope; the scope validator is the boundary that rejects them.
    const decoded = decodeEnvelope(wire)!;
    expect(validateEnvelopeScope(decoded)).toEqual({
      reason: "tenant_event_with_null_tenant",
      field: "tenantId",
    });
  });

  it("rejects a global event whose tenantId was injected in transit", () => {
    const wire = JSON.stringify({
      origin: "wa-1",
      tenantId: "tenant-a",
      event: { type: "template:status", payload: { id: "t1", status: "X" } },
    });
    const decoded = decodeEnvelope(wire)!;
    expect(validateEnvelopeScope(decoded)).toEqual({
      reason: "global_event_with_tenant",
      field: "tenantId",
    });
  });
});

describe("Payload validator after round-trip", () => {
  it("accepts a round-tripped well-formed message:new", () => {
    const env: RealtimeEnvelope = {
      origin: "wa-1",
      tenantId: "tenant-a",
      event: { type: "message:new", payload: { conversationId: "c1", message: {} } },
    };
    const decoded = decodeEnvelope(encodeEnvelope(env))!;
    expect(validatePayloadShape(decoded.event)).toBeNull();
  });

  it("rejects a wire-form payload missing required keys", () => {
    const wire = JSON.stringify({
      origin: "wa-1",
      tenantId: "tenant-a",
      event: { type: "message:new", payload: { message: {} } },
    });
    const decoded = decodeEnvelope(wire)!;
    expect(validatePayloadShape(decoded.event)).toEqual({
      reason: "payload_key_invalid",
      field: "conversationId",
    });
  });
});

describe("Combined validator on round-tripped envelopes", () => {
  it("passes a fully valid tenant envelope", () => {
    const env: RealtimeEnvelope = {
      origin: "wa-1",
      tenantId: "tenant-a",
      event: { type: "message:new", payload: { conversationId: "c1", message: {} } },
    };
    const decoded = decodeEnvelope(encodeEnvelope(env))!;
    expect(validateEnvelope(decoded)).toBeNull();
  });

  it("fails before payload when scope is wrong", () => {
    const wire = JSON.stringify({
      origin: "wa-1",
      tenantId: null,
      event: { type: "message:new", payload: { conversationId: "c1", message: {} } },
    });
    const decoded = decodeEnvelope(wire)!;
    expect(validateEnvelope(decoded)).toEqual({
      reason: "tenant_event_with_null_tenant",
      field: "tenantId",
    });
  });
});

/** Build a structurally valid payload for each canonical event type. */
function representativePayloadFor(type: string) {
  switch (type) {
    case "message:new":
      return { conversationId: "c1", message: { id: "m1" } };
    case "message:status":
      return { conversationId: "c1", waMessageId: "w1", status: "DELIVERED" };
    case "message:image-enriched":
      return { messageId: "m1", conversationId: "c1", enrichment: { description: "x" } };
    case "flow:submission":
      return { conversationId: "c1", submissionId: "s1", launchId: "l1" };
    case "conversation:updated":
      return { conversationId: "c1" };
    case "template:status":
      return { id: "tpl-1", status: "APPROVED" };
    default:
      throw new Error(`Unknown event type ${type}`);
  }
}
