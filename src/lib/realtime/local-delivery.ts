/**
 * WA-ERA4-02 — Local delivery helper for inbound Pub/Sub events.
 *
 * Exists as a separate function so the WebSocket Hub's local-publish path
 * and the Redis subscriber's remote-deliver path share the EXACT same
 * "iterate connections and send" loop. Centralizing the iteration is what
 * guarantees a single broken connection cannot skip the rest, and what
 * keeps tenant isolation consistent regardless of whether the event
 * originated locally or arrived over the wire.
 */
import type { RealtimeEvent } from "@/lib/realtime/distribution";
import type { WebSocket } from "ws";

export type LocalConnection = {
  ws: WebSocket;
  userId: string;
  tenantId: string;
  cookie: string;
  revalidate: ReturnType<typeof setInterval>;
};

/** WebSocket OPEN readyState per WHATWG. Numeric to avoid reaching into the
 *  `ws` package for the constant, which lets tests pass plain objects. */
const WS_OPEN = 1;

/**
 * Deliver a tenant-scoped event to every local connection whose
 * tenantId matches. Returns the number of connections a send was
 * attempted on (including those whose send threw — failures are
 * isolated per WA-ERA4-01).
 */
export function deliverTenantEventToLocal(
  connections: Set<LocalConnection>,
  event: RealtimeEvent,
  tenantId: string,
): number {
  const data = JSON.stringify(event);
  let attempted = 0;
  for (const info of connections) {
    if (info.tenantId !== tenantId) continue;
    attempted++;
    try {
      if (info.ws.readyState === WS_OPEN) {
        info.ws.send(data);
      }
    } catch (err) {
      // Send error isolation: a single broken socket must not block
      // other clients. The lifecycle test suite verifies this invariant.
      console.error(
        `[realtime] local send failed (tenant=${tenantId}): ${(err as Error).message}`,
      );
    }
  }
  return attempted;
}

/**
 * Deliver a global event to every local connection. The same send-error
 * isolation rule applies.
 */
export function deliverGlobalEventToLocal(
  connections: Set<LocalConnection>,
  event: RealtimeEvent,
): number {
  const data = JSON.stringify(event);
  let attempted = 0;
  for (const info of connections) {
    attempted++;
    try {
      if (info.ws.readyState === WS_OPEN) {
        info.ws.send(data);
      }
    } catch (err) {
      console.error(
        `[realtime] local send failed (global): ${(err as Error).message}`,
      );
    }
  }
  return attempted;
}
