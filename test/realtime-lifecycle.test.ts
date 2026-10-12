/**
 * Tests for WebSocket connection lifecycle hardening introduced in WA-ERA4-01.
 *
 * Covers:
 *  - Connection registration via registerClient()
 *  - Cleanup guarantees when a connection error fires (without a close event)
 *  - Send error isolation: a single broken send() must not block other clients
 *  - Graceful shutdown: shutdownRealtime() drains connections and stops the WSS
 *
 * These tests are pure unit tests against the Hub singleton — no real sockets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RT from "@/server/realtime";

vi.mock("@/lib/prisma", () => ({ prisma: { tenantMembership: { findUnique: vi.fn() } } }));
vi.mock("@/lib/auth-token", () => ({ verifySessionToken: vi.fn() }));

type HubHandle = {
  connections: Set<unknown>;
  publish: (e: { type: string; payload: unknown }, t: string | null) => void;
  publishGlobal: (e: { type: string; payload: unknown }) => void;
  wss: { close: () => void } | null;
};

function getHub(): HubHandle {
  return (globalThis as unknown as { __waRealtime: HubHandle }).__waRealtime;
}

function makeConn(overrides: Partial<{ tenantId: string; readyState: number; send: () => void }> = {}) {
  const send = overrides.send ?? vi.fn();
  return {
    ws: { readyState: overrides.readyState ?? 1 /* OPEN */, send },
    userId: "user-1",
    tenantId: overrides.tenantId ?? "tenant-a",
    cookie: "",
    revalidate: setInterval(() => {}, 60_000),
  };
}

async function getModule(): Promise<typeof RT> {
  const mod = await import("@/server/realtime");
  // Force the module's lazy getHub() to run so globalThis.__waRealtime is
  // populated. publish() with a null tenant is the cheapest side-effect-free
  // way to bootstrap without depending on a non-exported helper.
  mod.publish({ type: "__init__", payload: {} }, null);
  return mod;
}

describe("realtime hub lifecycle hardening (WA-ERA4-01)", () => {
  beforeEach(async () => {
    delete (globalThis as unknown as { __waRealtime?: unknown }).__waRealtime;
    await getModule();
  });

  afterEach(() => {
    const hub = (globalThis as unknown as { __waRealtime?: HubHandle }).__waRealtime;
    if (hub) {
      for (const info of hub.connections) {
        const i = info as { revalidate: ReturnType<typeof setInterval> };
        clearInterval(i.revalidate);
      }
      hub.connections.clear();
    }
    delete (globalThis as unknown as { __waRealtime?: unknown }).__waRealtime;
  });

  describe("connection registration", () => {
    it("registerClient adds the connection to the hub set", async () => {
      const mod = await getModule();
      const fakeWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
      mod.registerClient(getHub() as never, "u1", "tenant-x", "cookie", fakeWs as unknown as never);
      expect(getHub().connections.size).toBe(1);
      const info = [...getHub().connections][0] as { tenantId: string; userId: string };
      expect(info.tenantId).toBe("tenant-x");
      expect(info.userId).toBe("u1");
    });

    it("sends a connected handshake on registration", async () => {
      const mod = await getModule();
      const fakeWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
      mod.registerClient(getHub() as never, "u1", "tenant-x", "cookie", fakeWs as unknown as never);
      expect(fakeWs.send).toHaveBeenCalledTimes(1);
      const frame = JSON.parse((fakeWs.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(frame.type).toBe("connected");
      expect(frame.payload.tenantId).toBe("tenant-x");
    });
  });

  describe("cleanup on error path", () => {
    it("removes the connection when error fires (without a subsequent close)", async () => {
      const mod = await getModule();
      const handlers: Record<string, () => void> = {};
      const fakeWs = {
        on: (ev: string, fn: () => void) => {
          handlers[ev] = fn;
        },
        send: vi.fn(),
        close: vi.fn(),
      };
      mod.registerClient(getHub() as never, "u1", "tenant-x", "cookie", fakeWs as unknown as never);
      expect(getHub().connections.size).toBe(1);

      // Fire only the error handler; close is NOT fired.
      handlers.error!();

      expect(getHub().connections.size).toBe(0);
      expect(fakeWs.close).toHaveBeenCalled();
    });

    it("does not double-cleanup if both error and close fire", async () => {
      const mod = await getModule();
      const handlers: Record<string, () => void> = {};
      const fakeWs = {
        on: (ev: string, fn: () => void) => {
          handlers[ev] = fn;
        },
        send: vi.fn(),
        close: vi.fn(),
      };
      mod.registerClient(getHub() as never, "u1", "tenant-x", "cookie", fakeWs as unknown as never);

      handlers.error!();
      handlers.close!();
      handlers.close!(); // extra closes must be safe

      expect(getHub().connections.size).toBe(0);
    });

    it("clears the revalidation interval on cleanup", async () => {
      const mod = await getModule();
      const clearSpy = vi.spyOn(globalThis, "clearInterval");
      const handlers: Record<string, () => void> = {};
      const fakeWs = {
        on: (ev: string, fn: () => void) => {
          handlers[ev] = fn;
        },
        send: vi.fn(),
        close: vi.fn(),
      };
      mod.registerClient(getHub() as never, "u1", "tenant-x", "cookie", fakeWs as unknown as never);
      handlers.close!();
      expect(clearSpy).toHaveBeenCalled();
    });
  });

  describe("send error isolation", () => {
    it("publish() isolates a throwing send so the loop continues to other connections", async () => {
      const mod = await getModule();
      const sendOk = vi.fn();
      const sendBad = vi.fn(() => {
        throw new Error("socket broken");
      });
      const sendOtherTenant = vi.fn();

      getHub().connections.add(makeConn({ tenantId: "tenant-a", send: sendOk }));
      getHub().connections.add(makeConn({ tenantId: "tenant-a", send: sendBad }));
      getHub().connections.add(makeConn({ tenantId: "tenant-b", send: sendOtherTenant }));

      mod.publish({ type: "message:new", payload: { conversationId: "c1" } }, "tenant-a");

      expect(sendOk).toHaveBeenCalledTimes(1);
      expect(sendBad).toHaveBeenCalledTimes(1);
      expect(sendOtherTenant).not.toHaveBeenCalled();
    });

    it("publishGlobal() isolates a throwing send across all connections", async () => {
      const mod = await getModule();
      const sendOk = vi.fn();
      const sendBad = vi.fn(() => {
        throw new Error("socket broken");
      });

      getHub().connections.add(makeConn({ tenantId: "tenant-a", send: sendOk }));
      getHub().connections.add(makeConn({ tenantId: "tenant-b", send: sendBad }));

      mod.publishGlobal({ type: "template:status", payload: { id: "t1" } });

      expect(sendOk).toHaveBeenCalledTimes(1);
      expect(sendBad).toHaveBeenCalledTimes(1);
    });
  });

  describe("graceful shutdown", () => {
    it("shutdownRealtime closes every connection with 1001 and clears the set", async () => {
      const mod = await getModule();
      const close1 = vi.fn();
      const close2 = vi.fn();
      const c1 = makeConn({ send: vi.fn() });
      const c2 = makeConn({ send: vi.fn() });
      (c1.ws as unknown as { close: typeof close1 }).close = close1;
      (c2.ws as unknown as { close: typeof close2 }).close = close2;
      getHub().connections.add(c1);
      getHub().connections.add(c2);

      const wssClose = vi.fn();
      getHub().wss = { close: wssClose };

      mod.shutdownRealtime();

      expect(close1).toHaveBeenCalledWith(1001, "Server shutting down");
      expect(close2).toHaveBeenCalledWith(1001, "Server shutting down");
      expect(getHub().connections.size).toBe(0);
      expect(wssClose).toHaveBeenCalled();
      expect(getHub().wss).toBeNull();
    });

    it("shutdownRealtime is a no-op when no hub exists", async () => {
      delete (globalThis as unknown as { __waRealtime?: unknown }).__waRealtime;
      const mod = await import("@/server/realtime");
      expect(() => mod.shutdownRealtime()).not.toThrow();
    });
  });

  describe("invariants preserved", () => {
    it("publish() still fails closed for null tenant", async () => {
      const mod = await getModule();
      const send = vi.fn();
      getHub().connections.add(makeConn({ tenantId: "tenant-a", send }));
      mod.publish({ type: "message:new", payload: { id: "m1" } }, null);
      expect(send).not.toHaveBeenCalled();
    });

    it("publish() does not cross tenant boundaries", async () => {
      const mod = await getModule();
      const sendA = vi.fn();
      const sendB = vi.fn();
      getHub().connections.add(makeConn({ tenantId: "tenant-a", send: sendA }));
      getHub().connections.add(makeConn({ tenantId: "tenant-b", send: sendB }));
      mod.publish({ type: "message:new", payload: { id: "m1" } }, "tenant-a");
      expect(sendA).toHaveBeenCalledTimes(1);
      expect(sendB).not.toHaveBeenCalled();
    });

    it("skips connections whose ws is not OPEN (CLOSING/CLOSED)", async () => {
      const mod = await getModule();
      const send = vi.fn();
      getHub().connections.add(makeConn({ tenantId: "tenant-a", readyState: 3 /* CLOSED */, send }));
      mod.publish({ type: "message:new", payload: { id: "m1" } }, "tenant-a");
      expect(send).not.toHaveBeenCalled();
    });
  });
});
