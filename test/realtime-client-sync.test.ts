/**
 * WA-ERA4-05 — Client-side realtime synchronization regression tests.
 *
 * Deterministic, no I/O. Locks in the bounded synchronization
 * guarantees enforced by the Inbox client:
 *
 *  - Duplicate notifications are detected by stable message id and
 *    do not trigger a second refetch.
 *  - Out-of-order notifications (older timestamp than the high-water
 *    mark) are rejected so they cannot regress the visible ordering.
 *  - Targeted events refetch only the open thread; non-targeted
 *    events refetch only the list; well-known message:* events
 *    covering the open thread refetch both.
 *  - Unknown event types are ignored without altering state.
 *  - Tenant/conversation switching resets the seen-set, the
 *    high-water marks, and the request tokens so cross-tenant state
 *    cannot leak into the active window.
 *  - Request tokens detect a stale HTTP response: a response whose
 *    token is not the current one is rejected.
 */
import { describe, expect, it } from "vitest";
import {
  OrderingGuard,
  RequestToken,
  SeenSet,
  classifyEvent,
  messageIdentity,
  processEvent,
  seenKeyFor,
} from "@/lib/realtime/sync";

const KNOWN = ["message:new", "message:status", "message:image-enriched"];

function msg(id: string, conversationId: string, timestamp: string, extras: Record<string, unknown> = {}) {
  return {
    type: "message:new" as const,
    payload: {
      conversationId,
      message: { id, conversationId, timestamp, waMessageId: null, ...extras },
    },
  };
}

describe("classifyEvent", () => {
  it("ignores non-object input", () => {
    expect(classifyEvent(null as unknown as { type: string; payload: unknown }, "a")).toEqual({ kind: "ignore" });
  });
  it("ignores events with non-string type", () => {
    expect(classifyEvent({ type: 1 as unknown as string, payload: {} }, "a")).toEqual({ kind: "ignore" });
  });
  it("ignores malformed message payloads", () => {
    const v = classifyEvent({ type: "message:new", payload: null }, "a");
    expect(v).toEqual({ kind: "ignore" });
  });
  it("refetches list when payload lacks conversationId", () => {
    const v = classifyEvent({ type: "message:new", payload: { message: { id: "x" } } }, "c1");
    expect(v).toEqual({ kind: "refetch-list" });
  });
  it("refetches list when event targets a different conversation", () => {
    const v = classifyEvent(msg("m1", "c1", "2026-01-01T00:00:00Z"), "c2");
    expect(v).toEqual({ kind: "refetch-list" });
  });
  it("refetches list+thread when event targets the open conversation", () => {
    const v = classifyEvent(msg("m1", "c1", "2026-01-01T00:00:00Z"), "c1");
    expect(v).toEqual({ kind: "refetch-list-and-thread", conversationId: "c1" });
  });
  it("ignores non-message events", () => {
    expect(classifyEvent({ type: "flow:submission", payload: {} }, "c1")).toEqual({ kind: "ignore" });
  });
  it("ignores template:status (global, no conversationId)", () => {
    expect(classifyEvent({ type: "template:status", payload: { id: "t1", status: "APPROVED" } }, "c1")).toEqual({ kind: "ignore" });
  });
});

describe("messageIdentity + seenKeyFor", () => {
  it("returns null when neither id nor waMessageId is present", () => {
    expect(messageIdentity({})).toBeNull();
  });
  it("uses id when present", () => {
    expect(seenKeyFor(messageIdentity({ id: "m1" })!)).toBe("id:m1");
  });
  it("falls back to waMessageId", () => {
    expect(seenKeyFor(messageIdentity({ waMessageId: "wam-1" })!)).toBe("wa:wam-1");
  });
});

describe("SeenSet", () => {
  it("admits new ids and rejects duplicates", () => {
    const s = new SeenSet();
    expect(s.admit("c1", "id:m1")).toBe(true);
    expect(s.admit("c1", "id:m1")).toBe(false);
  });
  it("isolates ids per conversation", () => {
    const s = new SeenSet();
    expect(s.admit("c1", "id:m1")).toBe(true);
    expect(s.admit("c2", "id:m1")).toBe(true);
  });
  it("reset(conversation) clears one bucket", () => {
    const s = new SeenSet();
    s.admit("c1", "id:m1");
    s.admit("c2", "id:m2");
    s.reset("c1");
    expect(s.admit("c1", "id:m1")).toBe(true);
    expect(s.admit("c2", "id:m2")).toBe(false);
  });
  it("reset() with no arg clears everything", () => {
    const s = new SeenSet();
    s.admit("c1", "id:m1");
    s.reset();
    expect(s.admit("c1", "id:m1")).toBe(true);
  });
  it("ignores empty inputs", () => {
    const s = new SeenSet();
    expect(s.admit("", "id:m1")).toBe(true);
    expect(s.admit("c1", "")).toBe(true);
  });
  it("truncates when exceeding the bounded limit", () => {
    const s = new SeenSet();
    for (let i = 0; i < 700; i++) s.admit("c1", `id:m${i}`);
    // After truncation, the most recent ids should still be present.
    expect(s.admit("c1", "id:m699")).toBe(false);
    // Some of the very first ids should have been dropped.
    expect(s.admit("c1", "id:m0")).toBe(true);
  });
});

describe("OrderingGuard", () => {
  it("admits the first timestamp per conversation", () => {
    const o = new OrderingGuard();
    expect(o.admit("c1", "2026-01-01T00:00:00Z")).toBe(true);
  });
  it("admits strictly newer timestamps", () => {
    const o = new OrderingGuard();
    o.admit("c1", "2026-01-01T00:00:00Z");
    expect(o.admit("c1", "2026-01-01T00:00:01Z")).toBe(true);
  });
  it("rejects strictly older timestamps", () => {
    const o = new OrderingGuard();
    o.admit("c1", "2026-01-01T00:00:05Z");
    expect(o.admit("c1", "2026-01-01T00:00:00Z")).toBe(false);
  });
  it("admits equal timestamps (idempotent)", () => {
    const o = new OrderingGuard();
    o.admit("c1", "2026-01-01T00:00:00Z");
    expect(o.admit("c1", "2026-01-01T00:00:00Z")).toBe(true);
  });
  it("isolates per conversation", () => {
    const o = new OrderingGuard();
    o.admit("c1", "2026-01-01T00:00:05Z");
    expect(o.admit("c2", "2026-01-01T00:00:00Z")).toBe(true);
  });
  it("admits unparseable timestamps (cannot prove staleness)", () => {
    const o = new OrderingGuard();
    expect(o.admit("c1", "not-a-date")).toBe(true);
  });
  it("reset clears high-water marks", () => {
    const o = new OrderingGuard();
    o.admit("c1", "2026-01-01T00:00:05Z");
    o.reset("c1");
    expect(o.admit("c1", "2026-01-01T00:00:00Z")).toBe(true);
  });
});

describe("RequestToken", () => {
  it("isCurrent detects stale tokens", () => {
    const t = new RequestToken();
    const a = t.next();
    const b = t.next();
    expect(t.isCurrent(a)).toBe(false);
    expect(t.isCurrent(b)).toBe(true);
  });
  it("current_ matches the latest issued token", () => {
    const t = new RequestToken();
    t.next();
    const b = t.next();
    expect(t.current_()).toBe(b);
  });
});

describe("processEvent — dedup and staleness", () => {
  it("admits a new targeted message and triggers list+thread", () => {
    const s = new SeenSet();
    const o = new OrderingGuard();
    const v = processEvent(msg("m1", "c1", "2026-01-01T00:00:00Z"), "c1", s, o, KNOWN);
    expect(v.admitted).toBe(true);
    if (v.admitted) expect(v.action.kind).toBe("refetch-list-and-thread");
  });
  it("rejects the same event delivered twice", () => {
    const s = new SeenSet();
    const o = new OrderingGuard();
    const e = msg("m1", "c1", "2026-01-01T00:00:00Z");
    const first = processEvent(e, "c1", s, o, KNOWN);
    const second = processEvent(e, "c1", s, o, KNOWN);
    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(false);
    if (!second.admitted) expect(second.reason).toBe("duplicate");
  });
  it("rejects a stale event delivered after a newer one", () => {
    const s = new SeenSet();
    const o = new OrderingGuard();
    processEvent(msg("m1", "c1", "2026-01-01T00:00:05Z"), "c1", s, o, KNOWN);
    const stale = processEvent(msg("m2", "c1", "2026-01-01T00:00:00Z"), "c1", s, o, KNOWN);
    expect(stale.admitted).toBe(false);
    if (!stale.admitted) expect(stale.reason).toBe("stale");
  });
  it("ignores unknown event types when an allowlist is provided", () => {
    const s = new SeenSet();
    const o = new OrderingGuard();
    const v = processEvent(
      { type: "totally:unknown", payload: { conversationId: "c1", message: { id: "x" } } },
      "c1",
      s,
      o,
      KNOWN,
    );
    expect(v.admitted).toBe(false);
    if (!v.admitted) expect(v.reason).toBe("malformed");
  });
  it("admits a message:status event without an embedded message body", () => {
    const s = new SeenSet();
    const o = new OrderingGuard();
    const v = processEvent(
      { type: "message:status", payload: { conversationId: "c1", waMessageId: "wam-1", status: "DELIVERED" } },
      "c1",
      s,
      o,
      KNOWN,
    );
    expect(v.admitted).toBe(true);
  });
  it("dedups by waMessageId when no id is present", () => {
    const s = new SeenSet();
    const o = new OrderingGuard();
    const e = {
      type: "message:new" as const,
      payload: { conversationId: "c1", message: { waMessageId: "wam-1", timestamp: "2026-01-01T00:00:00Z" } },
    };
    expect(processEvent(e, "c1", s, o, KNOWN).admitted).toBe(true);
    const second = processEvent(e, "c1", s, o, KNOWN);
    expect(second.admitted).toBe(false);
    if (!second.admitted) expect(second.reason).toBe("duplicate");
  });
});

describe("tenant/conversation switching isolation", () => {
  it("reset() isolates seen ids and high-water marks between tenants", () => {
    const s = new SeenSet();
    const o = new OrderingGuard();
    processEvent(msg("m1", "t1", "2026-01-01T00:00:05Z"), "c1", s, o, KNOWN);
    // Simulate switching to tenant t2.
    s.reset();
    o.reset();
    // The older event for the same message id must be admitted in the
    // new tenant because the seen-set is empty.
    const v = processEvent(msg("m1", "t1", "2026-01-01T00:00:00Z"), "c1", s, o, KNOWN);
    expect(v.admitted).toBe(true);
  });
  it("RequestToken detects a stale HTTP response after switching", () => {
    const t = new RequestToken();
    const inflight = t.next();
    const next = t.next();
    expect(t.isCurrent(inflight)).toBe(false);
    expect(t.isCurrent(next)).toBe(true);
  });
});
