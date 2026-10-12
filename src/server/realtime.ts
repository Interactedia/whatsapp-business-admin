/**
 * Realtime hub (WebSocket fan-out).
 *
 * A single hub instance is stored on globalThis so that both the custom Node
 * server (server.ts) and Next.js route handlers — which Next compiles into a
 * separate module graph — share the exact same object. Route handlers call
 * `publish()` after DB writes; the custom server owns the WebSocketServer and
 * relays messages to authenticated browser clients.
 *
 * WA-ERA4-02: Multi-instance fan-out via Redis Pub/Sub.
 *   The Hub still owns local delivery. After publishing locally we hand the
 *   event to the Pub/Sub adapter (src/lib/realtime/distribution.ts) so peer
 *   instances receive it. Inbound events from the subscriber are delivered
 *   to local connections through the SAME helpers, ensuring tenant isolation
 *   and send-error isolation behave identically regardless of origin.
 */
import type { Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { verifySessionToken } from "@/lib/auth-token";
import { prisma } from "@/lib/prisma";
import {
  initRealtimeDistribution,
  publishToRedis,
  shutdownRealtimeDistribution,
  getPubSubState,
  type RealtimeEnvelope,
} from "@/lib/realtime/distribution";
import {
  deliverGlobalEventToLocal,
  deliverTenantEventToLocal,
} from "@/lib/realtime/local-delivery";

export type RealtimeEvent = {
  /** Event channel, e.g. "message:new", "message:status", "template:status". */
  type: string;
  /** Arbitrary JSON payload. */
  payload: unknown;
};

type ConnectionInfo = {
  ws: WebSocket;
  userId: string;
  tenantId: string;
  cookie: string;
  revalidate: ReturnType<typeof setInterval>;
};

type Hub = {
  wss: WebSocketServer | null;
  /** All active connections, each bound to exactly one authorized tenant. */
  connections: Set<ConnectionInfo>;
  publish: (event: RealtimeEvent, targetTenantId: string | null) => void;
  publishGlobal: (event: RealtimeEvent) => void;
};

const g = globalThis as unknown as { __waRealtime?: Hub };

function createHub(): Hub {
  const hub: Hub = {
    wss: null,
    connections: new Set(),
    publish(event: RealtimeEvent, targetTenantId: string | null) {
      // Fail closed: tenant-owned events with an unresolved tenant are never delivered.
      if (!targetTenantId) return;
      deliverTenantEventToLocal(hub.connections, event, targetTenantId);
      // Hand the event to the Pub/Sub adapter for fan-out to peer instances.
      // The adapter is a no-op when Redis is not configured, so single-process
      // deployments are unaffected. Fire-and-forget: the caller's PostgreSQL
      // commit is the source of truth, and a slow publish must not stall it.
      const state = getPubSubState();
      if (state) {
        const env: RealtimeEnvelope = {
          origin: state.instanceId,
          tenantId: targetTenantId,
          event,
        };
        void publishToRedis(env);
      }
    },
    publishGlobal(event: RealtimeEvent) {
      // Explicit escape hatch for surfaces that are NOT tenant-owned in the
      // current schema (e.g. template status). Never carry tenant message
      // payloads through this path.
      deliverGlobalEventToLocal(hub.connections, event);
      const state = getPubSubState();
      if (state) {
        const env: RealtimeEnvelope = {
          origin: state.instanceId,
          tenantId: null,
          event,
        };
        void publishToRedis(env);
      }
    },
  };
  return hub;
}

/**
 * Deliver a remote (Pub/Sub) event to local connections WITHOUT re-publishing
 * to Redis. The same tenant-isolation and send-error-isolation rules apply.
 * Tenant-scoped events only reach connections bound to the same tenant;
 * global events reach every connection.
 */
function deliverRemote(env: RealtimeEnvelope): void {
  const hub = getHub();
  if (env.tenantId === null || env.tenantId === undefined) {
    deliverGlobalEventToLocal(hub.connections, env.event);
    return;
  }
  deliverTenantEventToLocal(hub.connections, env.event, env.tenantId);
}

function getHub(): Hub {
  if (!g.__waRealtime) g.__waRealtime = createHub();
  return g.__waRealtime;
}

/**
 * Publish a tenant-owned event. Delivers ONLY to connections bound to
 * `tenantId`; a null/undefined tenant fails closed (no delivery).
 */
export function publish(event: RealtimeEvent, tenantId: string | null | undefined): void {
  getHub().publish(event, tenantId ?? null);
}

/**
 * Publish a global event for surfaces that are not tenant-owned in the
 * current schema (e.g. template:status). Payloads must not contain
 * tenant-owned message/conversation data or credentials.
 */
export function publishGlobal(event: RealtimeEvent): void {
  getHub().publishGlobal(event);
}

/**
 * Wire the Redis Pub/Sub fan-out layer onto the Hub. Idempotent: calling
 * it multiple times is safe and rebinds the inbound message handler to the
 * local-delivery function. Returns true when the adapter is active, false
 * when Redis is not configured (single-process mode).
 *
 * Call this once at server startup, after attachRealtime(). It does not
 * need to be awaited for correctness; the subscriber registers its
 * handlers synchronously and the SUBSCRIBE/PSUBSCRIBE is in flight.
 */
export function initRealtimeFanout(): boolean {
  const hub = getHub();
  const state = initRealtimeDistribution((env) => {
    // Inbound from a peer instance: deliver locally only. The Hub's
    // publish() path is intentionally NOT invoked here, so this code
    // never re-publishes a remote event back to Redis. That is the
    // loop-prevention invariant.
    deliverRemote(env);
    // Reference hub so the closure captures the live singleton; this also
    // makes the dependency explicit for future readers.
    void hub;
  });
  return state !== null;
}

/** Wire the WebSocketServer onto the shared HTTP server. Called once from server.ts. */
export function attachRealtime(server: HttpServer): void {
  const hub = getHub();
  if (hub.wss) return;

  const wss = new WebSocketServer({ noServer: true });
  hub.wss = wss;

  server.on("upgrade", (req, socket: Socket, head) => {
    const url = req.url;
    if (!url || !url.startsWith("/ws")) return; // let Next/HMR handle other upgrades

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
    } catch {
      socket.destroy();
      return;
    }
    const tenantId = parsedUrl.searchParams.get("tenantId");
    if (!tenantId) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    // Authenticate via the NextAuth session cookie on the upgrade request.
    const cookieHeader = req.headers.cookie || "";
    verifySessionToken(cookieHeader)
      .then(async (session) => {
        if (!session) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }

        const membership = await prisma.tenantMembership.findUnique({
          where: { userId_tenantId: { userId: session.userId, tenantId } },
          select: { id: true, user: { select: { active: true } } },
        });
        if (!membership || !membership.user.active) {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          registerClient(hub, session.userId, tenantId, cookieHeader, ws);
        });
      })
      .catch(() => {
        socket.destroy();
      });
  });
}

/**
 * ponytail: periodic revalidation (every 60s) is the revocation enforcement
 * point — a revoked membership or expired session closes within one interval.
 * Push invalidation from membership-revoke call sites if faster cutoff matters.
 */
const REVALIDATE_INTERVAL_MS = 60_000;

function registerClient(hub: Hub, userId: string, tenantId: string, cookie: string, ws: WebSocket) {
  const revalidate = setInterval(async () => {
    try {
      const session = await verifySessionToken(cookie);
      const membership = session
        ? await prisma.tenantMembership.findUnique({
            where: { userId_tenantId: { userId: session.userId, tenantId } },
            select: { id: true, user: { select: { active: true } } },
          })
        : null;
      if (!session || session.userId !== userId || !membership || !membership.user.active) {
        ws.close(4403, "Unauthorized");
      }
    } catch {
      ws.close(4403, "Unauthorized");
    }
  }, REVALIDATE_INTERVAL_MS);

  const info: ConnectionInfo = { ws, userId, tenantId, cookie, revalidate };
  hub.connections.add(info);

  // ponytail: cleanup runs once on whichever event fires first (close or error);
  // a broken socket may emit error without a subsequent close, so we teardown
  // eagerly on error to prevent a leaked interval and a Set entry that receives
  // no further events.
  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearInterval(info.revalidate);
    hub.connections.delete(info);
  }

  ws.on("close", cleanup);
  ws.on("error", () => {
    cleanup();
    try {
      ws.close();
    } catch {
      // Socket already in a terminal state; nothing to do.
    }
  });

  ws.send(JSON.stringify({ type: "connected", payload: { userId, tenantId } }));
}

// Exported for test-only lifecycle coverage. Not part of the public runtime API.
export { registerClient };

/**
 * Graceful shutdown — closes every active connection with a 1001 code (going
 * away), shuts down the WebSocketServer, and tears down the Redis Pub/Sub
 * adapter. Safe to call when no hub has been attached; in that case the
 * WebSocket-related steps are a no-op. The Pub/Sub teardown is also a
 * no-op when Redis is not configured.
 */
export async function shutdownRealtime(): Promise<void> {
  const hub = g.__waRealtime;
  if (!hub) {
    // Even without a Hub, the Pub/Sub adapter may have been initialized
    // (e.g. tests that wire it directly). Drain it.
    await shutdownRealtimeDistribution();
    return;
  }
  for (const info of hub.connections) {
    try {
      clearInterval(info.revalidate);
    } catch {
      // ignore
    }
    try {
      info.ws.close(1001, "Server shutting down");
    } catch {
      // socket already terminal
    }
  }
  hub.connections.clear();
  if (hub.wss) {
    try {
      hub.wss.close();
    } catch {
      // ignore
    }
    hub.wss = null;
  }
  // Tear down the Pub/Sub adapter so subscriber/publisher connections do
  // not outlive the process. Awaited so callers (server.ts) can chain other
  // shutdown steps.
  await shutdownRealtimeDistribution();
}
