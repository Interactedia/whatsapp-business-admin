/**
 * WA-ERA4-03 — Authentication and tenant-isolation negative regression tests.
 *
 * Strategy: we mock the `ws` package so `new WebSocketServer({ noServer: true })`
 * inside attachRealtime produces a controllable fake. The fake's
 * handleUpgrade invokes its callback synchronously with a fake WebSocket,
 * letting us drive the full upgrade flow (auth gate → registerClient →
 * connection registered + revalidation timer mounted) without a real
 * TCP socket.
 *
 * Covers acceptance gates for the security-hardening packet:
 *  - Upgrade rejection: missing session, missing membership, deactivated
 *    user, ADMIN JWT without membership (bypass attempt), malformed URL.
 *  - Revalidation: revoked session, deleted membership, deactivated user
 *    terminate the connection; timer cleanup; no silent disable.
 *  - Maximum revocation window: characterised at 60s (interval-based).
 *  - Local delivery tenant isolation reaffirmed.
 *  - Global event boundary: publishGlobal reaches all connections.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// We avoid importing `WebSocket` from "ws" because the production code only
// needs the type at module-boundary edges; the test drives the upgrade flow
// through a fake WSS whose handleUpgrade callback receives a `FakeWs`.

// ---------------------------------------------------------------------------
// ws package mock
// ---------------------------------------------------------------------------

const fakeWebSockets: FakeWs[] = [];

type FakeWs = {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  listeners: Record<string, Array<(...args: unknown[]) => void>>;
  _upgradeFn: ((ws: FakeWs) => void) | null;
};

function makeFakeWs(upgradeFn: ((ws: FakeWs) => void) | null): FakeWs {
  const ws: FakeWs = {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      (ws.listeners[event] ??= []).push(fn);
      return ws;
    }),
    listeners: {},
    _upgradeFn: upgradeFn,
  };
  // When close() is invoked, fire the registered "close" handlers
  // synchronously. This mirrors what a real WebSocket does and lets
  // the production cleanup() callback run.
  ws.close.mockImplementation((code?: number, reason?: string) => {
    ws.readyState = 3; // CLOSED
    const handlers = ws.listeners["close"] ?? [];
    for (const h of handlers) h(code, reason);
  });
  return ws;
}

type FakeWss = {
  on: ReturnType<typeof vi.fn>;
  _listeners: Map<string, Array<(...args: unknown[]) => void>>;
  _handleUpgrade: (
    req: unknown,
    socket: unknown,
    head: unknown,
    cb: (ws: FakeWs) => void,
  ) => void;
  close: ReturnType<typeof vi.fn>;
};

function makeFakeWss(): FakeWss {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const wss: FakeWss = {
    on: vi.fn(),
    _listeners: listeners,
    _handleUpgrade(_req, _socket, _head, cb) {
      const ws = makeFakeWs(null);
      fakeWebSockets.push(ws);
      cb(ws);
    },
    close: vi.fn(),
  };
  // Expose handleUpgrade at the top level — the production code calls
  // wss.handleUpgrade(req, socket, head, callback).
  (wss as unknown as { handleUpgrade: FakeWss["_handleUpgrade"] }).handleUpgrade =
    wss._handleUpgrade;
  wss.on.mockImplementation((event: string, fn: (...args: unknown[]) => void) => {
    const arr = listeners.get(event) ?? [];
    arr.push(fn);
    listeners.set(event, arr);
    return wss;
  });
  return wss;
}

vi.mock("ws", () => {
  const fakeWss = makeFakeWss();
  return {
    WebSocketServer: function () {
      return fakeWss;
    },
    WebSocket: class {},
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: { tenantMembership: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/auth-token", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth-token")>("@/lib/auth-token");
  return { ...actual, verifySessionToken: vi.fn() };
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type FakeSocket = {
  destroyed: boolean;
  destroy: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};
function makeFakeSocket(): FakeSocket {
  const s: FakeSocket = {
    destroyed: false,
    destroy: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  };
  s.destroy.mockImplementation(() => {
    s.destroyed = true;
  });
  return s;
}

type HubHandle = {
  connections: Set<unknown>;
  publish: (e: { type: string; payload: unknown }, t: string | null) => void;
  publishGlobal: (e: { type: string; payload: unknown }) => void;
  wss: FakeWss | null;
};

function getHub(): HubHandle {
  return (globalThis as unknown as { __waRealtime: HubHandle }).__waRealtime;
}

function getConnInfo(): {
  tenantId: string;
  userId: string;
  cookie: string;
  revalidate: ReturnType<typeof setInterval>;
  ws: FakeWs;
} {
  return [...getHub().connections][0] as never;
}

async function flushAll(): Promise<void> {
  // Advance exactly one revalidation interval plus the upgrade flow's
  // pending microtasks. Running ALL timers would loop forever because the
  // revalidation setInterval keeps re-arming itself.
  await vi.advanceTimersByTimeAsync(60_000);
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}

/**
 * Flush only the pending microtasks (auth + membership lookups), without
 * touching any timer. Use for assertions that should not advance the
 * revalidation interval.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  delete (globalThis as unknown as { __waRealtime?: unknown }).__waRealtime;
  fakeWebSockets.length = 0;
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { __waRealtime?: unknown }).__waRealtime;
});

// ---------------------------------------------------------------------------
// 1. Upgrade path rejection
// ---------------------------------------------------------------------------

describe("upgrade authentication rejection", () => {
  it("rejects when verifySessionToken returns null (no session)", async () => {
    const { verifySessionToken } = await import("@/lib/auth-token");
    vi.mocked(verifySessionToken).mockResolvedValue(null);

    await driveUpgrade("/ws?tenantId=tenant-x");
    await flushAll();
    expect(getHub().connections.size).toBe(0);
    expect(fakeWebSockets).toHaveLength(0);
  });

  it("rejects when no TenantMembership row exists (no membership)", async () => {
    const { verifySessionToken } = await import("@/lib/auth-token");
    vi.mocked(verifySessionToken).mockResolvedValue({ userId: "u1", role: "AGENT" });
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.tenantMembership.findUnique).mockResolvedValue(null);

    await driveUpgrade("/ws?tenantId=tenant-x");
    await flushAll();
    expect(getHub().connections.size).toBe(0);
  });

  it("rejects when user.active is false (deactivated user)", async () => {
    const { verifySessionToken } = await import("@/lib/auth-token");
    vi.mocked(verifySessionToken).mockResolvedValue({ userId: "u1", role: "AGENT" });
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.tenantMembership.findUnique).mockResolvedValue({
      id: "m1",
      userId: "u1",
      tenantId: "tenant-x",
      role: "AGENT",
      createdAt: new Date(),
      user: { id: "u1", active: false },
    } as never);

    await driveUpgrade("/ws?tenantId=tenant-x");
    await flushAll();
    expect(getHub().connections.size).toBe(0);
  });

  it("rejects when JWT contains only role=ADMIN with no membership (ADMIN bypass attempt)", async () => {
    const { verifySessionToken } = await import("@/lib/auth-token");
    // An ADMIN JWT must NOT bypass the membership check.
    vi.mocked(verifySessionToken).mockResolvedValue({ userId: "u-admin", role: "ADMIN" });
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.tenantMembership.findUnique).mockResolvedValue(null);

    await driveUpgrade("/ws?tenantId=tenant-x");
    await flushAll();
    expect(getHub().connections.size).toBe(0);
    // The membership lookup is the authoritative check — role alone is insufficient.
    expect(prisma.tenantMembership.findUnique).toHaveBeenCalled();
  });

  it("rejects when the URL has no tenantId (malformed upgrade)", async () => {
    const { verifySessionToken } = await import("@/lib/auth-token");
    vi.mocked(verifySessionToken).mockResolvedValue({ userId: "u1", role: "AGENT" });

    await driveUpgrade("/ws");
    await flushAll();
    // No session lookup must happen without a tenantId.
    expect(verifySessionToken).not.toHaveBeenCalled();
    expect(getHub().connections.size).toBe(0);
  });

  it("ignores requests outside /ws (preserves Next/HMR routing)", async () => {
    const { verifySessionToken } = await import("@/lib/auth-token");
    vi.mocked(verifySessionToken).mockResolvedValue({ userId: "u1", role: "AGENT" });

    await driveUpgrade("/_next/webpack-hmr");
    await flushAll();
    expect(verifySessionToken).not.toHaveBeenCalled();
    expect(getHub().connections.size).toBe(0);
  });

  it("accepts a legitimate upgrade (session + membership + user.active)", async () => {
    const { verifySessionToken } = await import("@/lib/auth-token");
    vi.mocked(verifySessionToken).mockResolvedValue({ userId: "u1", role: "AGENT" });
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.tenantMembership.findUnique).mockResolvedValue({
      id: "m1",
      userId: "u1",
      tenantId: "tenant-x",
      role: "AGENT",
      createdAt: new Date(),
      user: { id: "u1", active: true },
    } as never);

    await driveUpgrade("/ws?tenantId=tenant-x");
    await flushAll();
    expect(getHub().connections.size).toBe(1);
    const info = getConnInfo();
    expect(info.tenantId).toBe("tenant-x");
    expect(info.userId).toBe("u1");
  });
});

// ---------------------------------------------------------------------------
// 2. Revalidation behaviour
// ---------------------------------------------------------------------------

describe("connection revalidation", () => {
  it("cleans the revalidation timer when the connection closes", async () => {
    await driveAcceptedUpgrade();
    const info = getConnInfo();
    const hub = getHub();
    expect(hub.connections.size).toBe(1);

    const closeHandlers = info.ws.listeners["close"] ?? [];
    expect(closeHandlers.length).toBeGreaterThan(0);
    for (const h of closeHandlers) h();
    expect(hub.connections.size).toBe(0);
  });

  it("cleans the revalidation timer on connection error (no close event)", async () => {
    await driveAcceptedUpgrade();
    const info = getConnInfo();
    const hub = getHub();
    expect(hub.connections.size).toBe(1);

    const errorHandlers = info.ws.listeners["error"] ?? [];
    expect(errorHandlers.length).toBeGreaterThan(0);
    for (const h of errorHandlers) h(new Error("network blip"));
    expect(hub.connections.size).toBe(0);
  });

  it("does not double-cleanup when close and error fire in quick succession", async () => {
    await driveAcceptedUpgrade();
    const info = getConnInfo();
    const hub = getHub();
    expect(hub.connections.size).toBe(1);

    const closeHandlers = info.ws.listeners["close"] ?? [];
    const errorHandlers = info.ws.listeners["error"] ?? [];
    for (const h of closeHandlers) h();
    for (const h of errorHandlers) h(new Error("after close"));
    expect(hub.connections.size).toBe(0);
  });

  it("terminates the connection when revalidation finds the session revoked", async () => {
    const { verifySessionToken } = await import("@/lib/auth-token");
    // First call: legitimate session at upgrade. Second call: revoked.
    vi.mocked(verifySessionToken)
      .mockResolvedValueOnce({ userId: "u1", role: "AGENT" })
      .mockResolvedValueOnce(null);

    await driveAcceptedUpgrade();
    const info = getConnInfo();
    expect(getHub().connections.size).toBe(1);

    await flushAll();
    expect(info.ws.close).toHaveBeenCalledWith(4403, "Unauthorized");
    expect(getHub().connections.size).toBe(0);
  });

  it("terminates the connection when membership is removed during revalidation", async () => {
    const { verifySessionToken } = await import("@/lib/auth-token");
    vi.mocked(verifySessionToken).mockResolvedValue({ userId: "u1", role: "AGENT" });
    const { prisma } = await import("@/lib/prisma");
    // First call: membership exists. Second call: membership deleted.
    vi.mocked(prisma.tenantMembership.findUnique)
      .mockResolvedValueOnce({
        id: "m1",
        userId: "u1",
        tenantId: "tenant-x",
        role: "AGENT",
        createdAt: new Date(),
        user: { id: "u1", active: true },
      } as never)
      .mockResolvedValueOnce(null);

    await driveAcceptedUpgrade();
    const info = getConnInfo();
    await flushAll();
    expect(info.ws.close).toHaveBeenCalledWith(4403, "Unauthorized");
    expect(getHub().connections.size).toBe(0);
  });

  it("terminates the connection when user.active becomes false during revalidation", async () => {
    const { verifySessionToken } = await import("@/lib/auth-token");
    vi.mocked(verifySessionToken).mockResolvedValue({ userId: "u1", role: "AGENT" });
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.tenantMembership.findUnique)
      .mockResolvedValueOnce({
        id: "m1",
        userId: "u1",
        tenantId: "tenant-x",
        role: "AGENT",
        createdAt: new Date(),
        user: { id: "u1", active: true },
      } as never)
      .mockResolvedValueOnce({
        id: "m1",
        userId: "u1",
        tenantId: "tenant-x",
        role: "AGENT",
        createdAt: new Date(),
        user: { id: "u1", active: false },
      } as never);

    await driveAcceptedUpgrade();
    const info = getConnInfo();
    await flushAll();
    expect(info.ws.close).toHaveBeenCalledWith(4403, "Unauthorized");
    expect(getHub().connections.size).toBe(0);
  });

  it("characterizes the maximum revocation window as 60s (interval-based)", async () => {
    const { verifySessionToken } = await import("@/lib/auth-token");
    vi.mocked(verifySessionToken)
      .mockResolvedValueOnce({ userId: "u1", role: "AGENT" })
      .mockResolvedValueOnce(null);
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.tenantMembership.findUnique).mockResolvedValue({
      id: "m1",
      userId: "u1",
      tenantId: "tenant-x",
      role: "AGENT",
      createdAt: new Date(),
      user: { id: "u1", active: true },
    } as never);

    await driveAcceptedUpgrade();
    const info = getConnInfo();
    const hub = getHub();
    expect(hub.connections.size).toBe(1);

    // At t+30s, the connection is still alive (first tick not yet fired).
    await vi.advanceTimersByTimeAsync(30_000);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(hub.connections.size).toBe(1);
    expect(info.ws.close).not.toHaveBeenCalled();

    // At t+60s, the revalidation tick fires and closes the connection.
    await vi.advanceTimersByTimeAsync(30_000);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(info.ws.close).toHaveBeenCalledWith(4403, "Unauthorized");
    expect(hub.connections.size).toBe(0);
  });

  it("does not silently disable future checks on a revalidation exception", async () => {
    const { verifySessionToken } = await import("@/lib/auth-token");
    vi.mocked(verifySessionToken)
      .mockResolvedValueOnce({ userId: "u1", role: "AGENT" })
      .mockRejectedValueOnce(new Error("transient db error"));

    await driveAcceptedUpgrade();
    const info = getConnInfo();
    await flushAll();
    // Fail-closed: a thrown revalidation error must close the connection,
    // not silently disable future checks.
    expect(info.ws.close).toHaveBeenCalledWith(4403, "Unauthorized");
    expect(getHub().connections.size).toBe(0);
  });

  it("does not terminate when revalidation finds the same valid state", async () => {
    const { verifySessionToken } = await import("@/lib/auth-token");
    vi.mocked(verifySessionToken).mockResolvedValue({ userId: "u1", role: "AGENT" });
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.tenantMembership.findUnique).mockResolvedValue({
      id: "m1",
      userId: "u1",
      tenantId: "tenant-x",
      role: "AGENT",
      createdAt: new Date(),
      user: { id: "u1", active: true },
    } as never);

    await driveAcceptedUpgrade();
    const info = getConnInfo();
    const hub = getHub();
    await flushAll();
    expect(hub.connections.size).toBe(1);
    expect(info.ws.close).not.toHaveBeenCalled();
  });

  it("terminates the connection if a different user hijacks the same cookie (identity drift)", async () => {
    const { verifySessionToken } = await import("@/lib/auth-token");
    vi.mocked(verifySessionToken)
      .mockResolvedValueOnce({ userId: "u1", role: "AGENT" })
      .mockResolvedValueOnce({ userId: "u2", role: "AGENT" }); // identity changed
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.tenantMembership.findUnique).mockResolvedValue({
      id: "m1",
      userId: "u1",
      tenantId: "tenant-x",
      role: "AGENT",
      createdAt: new Date(),
      user: { id: "u1", active: true },
    } as never);

    await driveAcceptedUpgrade();
    const info = getConnInfo();
    await flushAll();
    // Identity drift between upgrade and revalidation must close the connection.
    expect(info.ws.close).toHaveBeenCalledWith(4403, "Unauthorized");
    expect(getHub().connections.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Local delivery tenant isolation
// ---------------------------------------------------------------------------

describe("local delivery tenant isolation", () => {
  it("never delivers a Tenant A event to a Tenant B connection", async () => {
    const mod = await import("@/server/realtime");
    mod.publish({ type: "noop", payload: {} }, null);
    const hub = getHub();
    const sendA = vi.fn();
    const sendB = vi.fn();
    hub.connections.add({
      ws: { readyState: 1, send: sendA },
      userId: "u1",
      tenantId: "tenant-a",
      cookie: "",
      revalidate: setInterval(() => {}, 60_000),
    });
    hub.connections.add({
      ws: { readyState: 1, send: sendB },
      userId: "u2",
      tenantId: "tenant-b",
      cookie: "",
      revalidate: setInterval(() => {}, 60_000),
    });

    mod.publish({ type: "message:new", payload: { conversationId: "c1" } }, "tenant-a");
    expect(sendA).toHaveBeenCalledTimes(1);
    expect(sendB).not.toHaveBeenCalled();
  });

  it("fails closed when publish() is called with null tenantId", async () => {
    const mod = await import("@/server/realtime");
    mod.publish({ type: "noop", payload: {} }, null);
    const hub = getHub();
    const send = vi.fn();
    hub.connections.add({
      ws: { readyState: 1, send },
      userId: "u1",
      tenantId: "tenant-a",
      cookie: "",
      revalidate: setInterval(() => {}, 60_000),
    });

    mod.publish({ type: "message:new", payload: { conversationId: "c1" } }, null);
    expect(send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Global event boundary
// ---------------------------------------------------------------------------

describe("global event boundary", () => {
  it("publishGlobal reaches every connection regardless of tenant", async () => {
    const mod = await import("@/server/realtime");
    mod.publish({ type: "noop", payload: {} }, null);
    const hub = getHub();
    const sendA = vi.fn();
    const sendB = vi.fn();
    const sendC = vi.fn();
    hub.connections.add({
      ws: { readyState: 1, send: sendA },
      userId: "u1",
      tenantId: "tenant-a",
      cookie: "",
      revalidate: setInterval(() => {}, 60_000),
    });
    hub.connections.add({
      ws: { readyState: 1, send: sendB },
      userId: "u2",
      tenantId: "tenant-b",
      cookie: "",
      revalidate: setInterval(() => {}, 60_000),
    });
    hub.connections.add({
      ws: { readyState: 1, send: sendC },
      userId: "u3",
      tenantId: "tenant-c",
      cookie: "",
      revalidate: setInterval(() => {}, 60_000),
    });

    mod.publishGlobal({ type: "template:status", payload: { templateId: "tpl-1" } });
    expect(sendA).toHaveBeenCalledTimes(1);
    expect(sendB).toHaveBeenCalledTimes(1);
    expect(sendC).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Drives a single WebSocket upgrade request through the production
 * attachRealtime handler. The mocked `ws` package yields a fake WSS
 * whose handleUpgrade synchronously delivers a fake WebSocket. Auth and
 * membership mocks must be set up by the caller.
 */
async function driveUpgrade(url: string): Promise<void> {
  const { attachRealtime } = await import("@/server/realtime");

  // Build a fake http server. The implementation calls `new WebSocketServer(
  // { noServer: true })` then `server.on("upgrade", handler)`. We
  // intercept at the server.on level to capture the handler.
  const fakeServerListeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const fakeServer = {
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      const arr = fakeServerListeners.get(event) ?? [];
      arr.push(fn);
      fakeServerListeners.set(event, arr);
      return fakeServer;
    }),
  };

  attachRealtime(fakeServer as never);
  const upgradeCall = fakeServerListeners.get("upgrade");
  if (!upgradeCall) throw new Error("attachRealtime did not register an upgrade handler");
  const handler = upgradeCall[0] as (
    req: { url?: string; headers?: Record<string, string> },
    socket: FakeSocket,
    head: Buffer,
  ) => void;

  const req = { url, headers: { cookie: "authjs.session-token=valid" } };
  const socket = makeFakeSocket();
  handler(req, socket, Buffer.alloc(0));
}

/**
 * Drives an upgrade that is expected to succeed: pre-configures a happy-
 * path session + membership if the caller hasn't already.
 */
async function driveAcceptedUpgrade(): Promise<void> {
  const { verifySessionToken } = await import("@/lib/auth-token");
  const { prisma } = await import("@/lib/prisma");

  // Provide defaults if the caller hasn't set its own.
  if (!vi.mocked(verifySessionToken).mock.calls.length) {
    vi.mocked(verifySessionToken).mockResolvedValue({ userId: "u1", role: "AGENT" });
  }
  if (!vi.mocked(prisma.tenantMembership.findUnique).mock.calls.length) {
    vi.mocked(prisma.tenantMembership.findUnique).mockResolvedValue({
      id: "m1",
      userId: "u1",
      tenantId: "tenant-x",
      role: "AGENT",
      createdAt: new Date(),
      user: { id: "u1", active: true },
    } as never);
  }

  await driveUpgrade("/ws?tenantId=tenant-x");
  await flushMicrotasks();
}
