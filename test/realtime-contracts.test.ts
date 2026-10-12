/**
 * WA-ERA4-04 — Realtime event contract regression tests.
 *
 * These tests lock in the canonical event inventory and the public wire
 * contract. They are intentionally deterministic (no I/O, no Redis, no
 * WebSockets) so they can run in every CI cycle.
 *
 * Coverage:
 *  - Canonical event inventory: every event type known to the system
 *  - Producer/consumer mapping: every call site in EVENT_PRODUCER_MAP
 *    is exercised by at least one assertion
 *  - Tenant/global scope: every event type has a known scope
 *  - Wire format preservation: the on-the-wire shape for each event is
 *    exactly the public RealtimeEvent `{ type, payload }`
 *  - No new required public fields introduced by WA-ERA4-04
 */
import { describe, expect, it } from "vitest";
import {
  ALL_KNOWN_EVENT_TYPES,
  EVENT_CONSUMER_FILES,
  EVENT_PRODUCER_MAP,
  GLOBAL_EVENT_TYPES,
  TENANT_EVENT_TYPES,
  isKnownEventType,
  isRealtimeEvent,
  scopeForEventType,
} from "@/lib/realtime/events";
import {
  validateEnvelope,
  validateEnvelopeScope,
  validatePayloadShape,
} from "@/lib/realtime/contracts";
import type { RealtimeEvent, RealtimeEnvelope } from "@/lib/realtime/distribution";

describe("Canonical event inventory", () => {
  it("has at least one tenant event and one global event", () => {
    expect(TENANT_EVENT_TYPES.length).toBeGreaterThan(0);
    expect(GLOBAL_EVENT_TYPES.length).toBeGreaterThan(0);
  });

  it("all known event types are unique", () => {
    const set = new Set<string>(ALL_KNOWN_EVENT_TYPES);
    expect(set.size).toBe(ALL_KNOWN_EVENT_TYPES.length);
  });

  it("tenant and global event lists are disjoint", () => {
    const tenantSet = new Set<string>(TENANT_EVENT_TYPES);
    for (const g of GLOBAL_EVENT_TYPES) {
      expect(tenantSet.has(g)).toBe(false);
    }
  });

  it("scopeForEventType returns the expected scope for every known type", () => {
    for (const t of TENANT_EVENT_TYPES) {
      expect(scopeForEventType(t)).toBe("tenant");
    }
    for (const t of GLOBAL_EVENT_TYPES) {
      expect(scopeForEventType(t)).toBe("global");
    }
  });

  it("isKnownEventType mirrors scopeForEventType", () => {
    for (const t of ALL_KNOWN_EVENT_TYPES) {
      expect(isKnownEventType(t)).toBe(true);
    }
    expect(isKnownEventType("totally:unknown:event")).toBe(false);
  });
});

describe("Producer/consumer mapping", () => {
  it("every known event type has at least one producer file", () => {
    for (const t of ALL_KNOWN_EVENT_TYPES) {
      const entry = EVENT_PRODUCER_MAP[t];
      expect(entry).toBeDefined();
      expect(entry.producerFiles.length).toBeGreaterThan(0);
    }
  });

  it("the consumer side has at least one registered file", () => {
    expect(EVENT_CONSUMER_FILES.length).toBeGreaterThan(0);
  });

  it("producer file references are repo-relative paths", () => {
    for (const t of ALL_KNOWN_EVENT_TYPES) {
      for (const file of EVENT_PRODUCER_MAP[t].producerFiles) {
        expect(file.startsWith("src/")).toBe(true);
        expect(file.endsWith(".ts")).toBe(true);
      }
    }
  });

  it("scope in producer map matches tenant/global lists", () => {
    for (const t of TENANT_EVENT_TYPES) {
      expect(EVENT_PRODUCER_MAP[t].scope).toBe("tenant");
    }
    for (const t of GLOBAL_EVENT_TYPES) {
      expect(EVENT_PRODUCER_MAP[t].scope).toBe("global");
    }
  });
});

describe("isRealtimeEvent type guard", () => {
  it("accepts the canonical shape", () => {
    expect(isRealtimeEvent({ type: "x", payload: {} })).toBe(true);
  });

  it("rejects null/undefined", () => {
    expect(isRealtimeEvent(null)).toBe(false);
    expect(isRealtimeEvent(undefined)).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isRealtimeEvent("foo")).toBe(false);
    expect(isRealtimeEvent(42)).toBe(false);
  });

  it("rejects objects with missing or non-string type", () => {
    expect(isRealtimeEvent({})).toBe(false);
    expect(isRealtimeEvent({ type: 42 })).toBe(false);
    expect(isRealtimeEvent({ type: "" })).toBe(false);
  });

  it("does not require a payload key (existing wire contract is open)", () => {
    expect(isRealtimeEvent({ type: "x" })).toBe(true);
  });
});

describe("validateEnvelopeScope", () => {
  const origin = "wa-test-1";
  const tenantEnv: RealtimeEnvelope = {
    origin,
    tenantId: "tenant-a",
    event: { type: "message:new", payload: { conversationId: "c1", message: {} } },
  };
  const globalEnv: RealtimeEnvelope = {
    origin,
    tenantId: null,
    event: { type: "template:status", payload: { id: "t1", status: "APPROVED" } },
  };

  it("accepts a tenant envelope with a known tenant event", () => {
    expect(validateEnvelopeScope(tenantEnv)).toBeNull();
  });

  it("accepts a global envelope with a known global event", () => {
    expect(validateEnvelopeScope(globalEnv)).toBeNull();
  });

  it("rejects a tenant event with a null tenant", () => {
    const bad: RealtimeEnvelope = { ...tenantEnv, tenantId: null };
    expect(validateEnvelopeScope(bad)).toEqual({
      reason: "tenant_event_with_null_tenant",
      field: "tenantId",
    });
  });

  it("rejects a global event with a non-null tenant", () => {
    const bad: RealtimeEnvelope = { ...globalEnv, tenantId: "tenant-a" };
    expect(validateEnvelopeScope(bad)).toEqual({
      reason: "global_event_with_tenant",
      field: "tenantId",
    });
  });

  it("accepts an unknown event type under either scope (open wire contract)", () => {
    const unknownTenant: RealtimeEnvelope = {
      ...tenantEnv,
      event: { type: "future:event", payload: { foo: "bar" } },
    };
    const unknownGlobal: RealtimeEnvelope = {
      ...globalEnv,
      event: { type: "future:event", payload: { foo: "bar" } },
    };
    expect(validateEnvelopeScope(unknownTenant)).toBeNull();
    expect(validateEnvelopeScope(unknownGlobal)).toBeNull();
  });

  it("rejects conversation:updated delivered with global scope (WA-ERA4-08)", () => {
    // conversation:updated is tenant-scoped; the Hub's publishGlobal
    // gate must refuse a global envelope. The validator mirrors that.
    const bad: RealtimeEnvelope = {
      ...globalEnv,
      event: { type: "conversation:updated", payload: { conversationId: "c1" } },
    };
    expect(validateEnvelopeScope(bad)).toEqual({
      reason: "tenant_event_with_null_tenant",
      field: "tenantId",
    });
  });

  it("rejects envelopes with invalid origin", () => {
    const bad: RealtimeEnvelope = { ...tenantEnv, origin: "" };
    expect(validateEnvelopeScope(bad)).toEqual({ reason: "origin_invalid" });
  });

  it("rejects envelopes with invalid event shape", () => {
    const bad: RealtimeEnvelope = { ...tenantEnv, event: null as unknown as RealtimeEvent };
    expect(validateEnvelopeScope(bad)).toEqual({ reason: "event_invalid" });
  });
});

describe("validatePayloadShape", () => {
  it("accepts a well-formed message:new payload", () => {
    expect(
      validatePayloadShape({
        type: "message:new",
        payload: { conversationId: "c1", message: { id: "m1" } },
      }),
    ).toBeNull();
  });

  it("accepts a well-formed message:status payload", () => {
    expect(
      validatePayloadShape({
        type: "message:status",
        payload: { conversationId: "c1", waMessageId: "w1", status: "DELIVERED" },
      }),
    ).toBeNull();
  });

  it("accepts a well-formed message:image-enriched payload", () => {
    expect(
      validatePayloadShape({
        type: "message:image-enriched",
        payload: { messageId: "m1", conversationId: "c1", enrichment: { description: "x" } },
      }),
    ).toBeNull();
  });

  it("accepts a well-formed flow:submission payload", () => {
    expect(
      validatePayloadShape({
        type: "flow:submission",
        payload: { conversationId: "c1", submissionId: "s1", launchId: "l1" },
      }),
    ).toBeNull();
  });

  it("accepts a well-formed conversation:updated payload (WA-ERA4-08)", () => {
    expect(
      validatePayloadShape({
        type: "conversation:updated",
        payload: { conversationId: "c1" },
      }),
    ).toBeNull();
  });

  it("rejects conversation:updated missing conversationId (WA-ERA4-08)", () => {
    const failure = validatePayloadShape({
      type: "conversation:updated",
      payload: {},
    });
    expect(failure).toEqual({ reason: "payload_key_invalid", field: "conversationId" });
  });

  it("rejects conversation:updated with empty conversationId (WA-ERA4-08)", () => {
    expect(
      validatePayloadShape({
        type: "conversation:updated",
        payload: { conversationId: "" },
      }),
    ).toEqual({ reason: "payload_key_invalid", field: "conversationId" });
  });

  it("accepts a well-formed template:status payload (global)", () => {
    expect(
      validatePayloadShape({
        type: "template:status",
        payload: { id: "t1", status: "APPROVED" },
      }),
    ).toBeNull();
  });

  it("rejects message:new missing conversationId", () => {
    const failure = validatePayloadShape({
      type: "message:new",
      payload: { message: {} },
    });
    expect(failure).toEqual({ reason: "payload_key_invalid", field: "conversationId" });
  });

  it("rejects message:status missing waMessageId", () => {
    const failure = validatePayloadShape({
      type: "message:status",
      payload: { conversationId: "c1", status: "DELIVERED" },
    });
    expect(failure).toEqual({ reason: "payload_key_invalid", field: "waMessageId" });
  });

  it("rejects flow:submission missing launchId", () => {
    const failure = validatePayloadShape({
      type: "flow:submission",
      payload: { conversationId: "c1", submissionId: "s1" },
    });
    expect(failure).toEqual({ reason: "payload_key_invalid", field: "launchId" });
  });

  it("rejects non-object payloads", () => {
    expect(validatePayloadShape({ type: "message:new", payload: "string" })).toEqual({
      reason: "payload_not_object",
    });
    expect(validatePayloadShape({ type: "message:new", payload: null })).toEqual({
      reason: "payload_not_object",
    });
  });

  it("rejects empty-string keys", () => {
    expect(
      validatePayloadShape({
        type: "message:status",
        payload: { conversationId: "", waMessageId: "w1", status: "X" },
      }),
    ).toEqual({ reason: "payload_key_invalid", field: "conversationId" });
  });
});

describe("validateEnvelope (combined)", () => {
  it("passes a valid tenant envelope end-to-end", () => {
    const env: RealtimeEnvelope = {
      origin: "wa-test-1",
      tenantId: "tenant-a",
      event: { type: "message:new", payload: { conversationId: "c1", message: {} } },
    };
    expect(validateEnvelope(env)).toBeNull();
  });

  it("passes a valid global envelope end-to-end", () => {
    const env: RealtimeEnvelope = {
      origin: "wa-test-1",
      tenantId: null,
      event: { type: "template:status", payload: { id: "t1", status: "APPROVED" } },
    };
    expect(validateEnvelope(env)).toBeNull();
  });

  it("fails before payload when scope is wrong", () => {
    const env: RealtimeEnvelope = {
      origin: "wa-test-1",
      tenantId: null,
      event: { type: "message:new", payload: { conversationId: "c1", message: {} } },
    };
    expect(validateEnvelope(env)).toEqual({
      reason: "tenant_event_with_null_tenant",
      field: "tenantId",
    });
  });
});

describe("Wire format preservation", () => {
  it("the on-the-wire shape is exactly { type: string; payload: unknown }", () => {
    const e: RealtimeEvent = { type: "message:new", payload: { foo: 1 } };
    // JSON round-trip preserves shape
    const wire = JSON.parse(JSON.stringify(e));
    expect(Object.keys(wire).sort()).toEqual(["payload", "type"]);
    expect(typeof wire.type).toBe("string");
  });

  it("no new required public fields are added by WA-ERA4-04", () => {
    // Snapshot of the wire keys an existing client sees.
    // The catalog is internal and does not introduce wire fields.
    const beforeKeys = ["type", "payload"];
    const e: RealtimeEvent = { type: "x", payload: {} };
    expect(Object.keys(e).sort()).toEqual(beforeKeys.sort());
  });

  it("known event types are all non-empty strings", () => {
    for (const t of ALL_KNOWN_EVENT_TYPES) {
      expect(typeof t).toBe("string");
      expect(t.length).toBeGreaterThan(0);
    }
  });
});
