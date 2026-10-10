/**
 * Realtime hub (WebSocket fan-out).
 *
 * A single hub instance is stored on globalThis so that both the custom Node
 * server (server.ts) and Next.js route handlers — which Next compiles into a
 * separate module graph — share the exact same object. Route handlers call
 * `publish()` after DB writes; the custom server owns the WebSocketServer and
 * relays messages to authenticated browser clients.
 */
import type { Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { verifySessionToken } from "@/lib/auth-token";
import { prisma } from "@/lib/prisma";

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
      const data = JSON.stringify(event);
      for (const info of hub.connections) {
        if (info.tenantId !== targetTenantId) continue;
        if (info.ws.readyState === WebSocket.OPEN) {
          info.ws.send(data);
        }
      }
    },
    publishGlobal(event: RealtimeEvent) {
      // Explicit escape hatch for surfaces that are NOT tenant-owned in the
      // current schema (e.g. template status). Never carry tenant message
      // payloads through this path.
      const data = JSON.stringify(event);
      for (const info of hub.connections) {
        if (info.ws.readyState === WebSocket.OPEN) {
          info.ws.send(data);
        }
      }
    },
  };
  return hub;
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

  ws.on("close", () => {
    clearInterval(info.revalidate);
    hub.connections.delete(info);
  });
  ws.on("error", () => ws.close());

  ws.send(JSON.stringify({ type: "connected", payload: { userId, tenantId } }));
}
