"use client";

import { useEffect, useRef } from "react";

export type RealtimeMessage = { type: string; payload: unknown };

/**
 * Subscribe to the server WebSocket (/ws?tenantId=…). Reconnects with backoff.
 * The connection is bound to exactly one tenant; changing tenantId reconnects.
 * The handler ref is kept current so callers don't need a stable callback.
 */
export function useRealtime(tenantId: string | null | undefined, onEvent: (msg: RealtimeMessage) => void) {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!tenantId) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout>;

    function connect() {
      if (closed) return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${window.location.host}/ws?tenantId=${encodeURIComponent(tenantId!)}`);

      ws.onopen = () => {
        retry = 0;
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
