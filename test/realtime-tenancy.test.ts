import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: { tenantMembership: { findUnique: vi.fn() } } }));
vi.mock("@/lib/auth-token", () => ({ verifySessionToken: vi.fn() }));

describe("tenant-bound realtime publication", () => {
  beforeEach(() => {
    delete (globalThis as unknown as { __waRealtime?: unknown }).__waRealtime;
  });

  it("delivers tenant events only to matching tenant connections", async () => {
    const { publish } = await import("@/server/realtime");
    publish({ type: "noop", payload: {} }, null);

    const hub = (globalThis as unknown as { __waRealtime: { connections: Set<unknown> } }).__waRealtime;
    const sendA = vi.fn();
    const sendB = vi.fn();
    hub.connections.add({ ws: { readyState: 1, send: sendA }, userId: "user-1", tenantId: "tenant-a", cookie: "", revalidate: setInterval(() => {}, 1) });
    hub.connections.add({ ws: { readyState: 1, send: sendB }, userId: "user-1", tenantId: "tenant-b", cookie: "", revalidate: setInterval(() => {}, 1) });

    publish({ type: "message:new", payload: { conversationId: "c1" } }, "tenant-a");

    expect(sendA).toHaveBeenCalledTimes(1);
    expect(sendB).not.toHaveBeenCalled();
  });

  it("does not globally broadcast tenant events without a tenant", async () => {
    const { publish } = await import("@/server/realtime");
    publish({ type: "noop", payload: {} }, null);

    const hub = (globalThis as unknown as { __waRealtime: { connections: Set<unknown> } }).__waRealtime;
    const send = vi.fn();
    hub.connections.add({ ws: { readyState: 1, send }, userId: "user-1", tenantId: "tenant-a", cookie: "", revalidate: setInterval(() => {}, 1) });

    publish({ type: "message:new", payload: { conversationId: "c1" } }, null);

    expect(send).not.toHaveBeenCalled();
  });
});
