"use client";

import { useEffect, useRef } from "react";

export type RealtimeMessage = { type: string; payload: unknown };

/**
 * Subscribe to the server WebSocket (/ws?tenantId=…). Reconnects with backoff.
 * The connection is bound to exactly one tenant; changing tenantId reconnects.
 * The handler ref is kept current so callers don't need a stable callback.
 *
 * WA-ERA4-09: Optional `onReconnect` fires ONLY on a successful re-open that
 * followed a previous close (i.e. NOT the initial open). It is the recovery
 * signal that callers use to trigger a canonical HTTP refetch — Redis Pub/Sub
 * does not retain missed events, so after a disconnect the client must rebuild
 * its state from PostgreSQL-backed HTTP endpoints. Tenant switch also resets
 * the hook (the effect re-runs), so a fresh `tenantId` will not fire
 * `onReconnect` until a subsequent disconnect/reconnect.
 */
export function useRealtime(
  tenantId: string | null | undefined,
  onEvent: (msg: RealtimeMessage) => void,
  onReconnect?: () => void,
) {
  const handlerRef = useRef(onEvent);
  const reconnectRef = useRef(onReconnect);
  handlerRef.current = onEvent;
  reconnectRef.current = onReconnect;

  useEffect(() => {
    if (!tenantId) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout>;
    // Tracks whether the socket has ever been open. The first onopen is the
    // initial connect (NOT a reconnect); every subsequent onopen is a reconnect.
    let hasOpened = false;

    function connect() {
      if (closed) return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${window.location.host}/ws?tenantId=${encodeURIComponent(tenantId!)}`);

      ws.onopen = () => {
        const isReconnect = hasOpened;
        hasOpened = true;
        retry = 0;
        if (isReconnect) {
          // WA-ERA4-09: notify the caller so it can recover canonical state.
          // Intentionally fires AFTER retry is reset so the caller's refetch
          // is the authoritative reconciliation, not another retry tick.
          try {
            reconnectRef.current?.();
          } catch {
            // The recovery callback must not break the socket lifecycle.
            // A failure to recover canonical state surfaces as stale UI, but
            // the socket itself stays healthy for subsequent events.
          }
        }
      };
      ws.onmessage = (ev) => {
        try {
          handlerRef.current(JSON.parse(ev.data));
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        retry = Math.min(retry + 1, 6);
        timer = setTimeout(connect, 500 * 2 ** retry);
      };
      ws.onerror = () => ws?.close();
    }

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [tenantId]);
}
