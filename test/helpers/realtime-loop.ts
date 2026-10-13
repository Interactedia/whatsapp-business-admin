/**
 * WA-ERA4-09 — Test-only helper that exposes the `useRealtime` connection
 * loop without depending on a React renderer. The loop is intentionally
 * kept identical to the one in src/hooks/use-realtime.ts so the lifecycle
 * behavior is the same in tests and production.
 *
 * This file is consumed only by test/realtime-reconnect-recovery.test.ts.
 * Production code continues to import the React hook directly.
 */
export type RealtimeMessage = { type: string; payload: unknown };

export type RealtimeConnectionOptions = {
  tenantId: string | null;
  onEvent: (msg: RealtimeMessage) => void;
  onReconnect?: () => void;
  /** Override the WebSocket constructor; defaults to globalThis.WebSocket. */
  WebSocketCtor?: new (url: string) => unknown;
  /** Override the timer scheduler; defaults to globalThis.setTimeout. */
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  /** Override the timer clearer; defaults to globalThis.clearTimeout. */
  clearTimeoutFn?: (handle: unknown) => void;
};

export type RealtimeConnection = {
  dispose: () => void;
};

const WS_OPEN = 1;

function pickWebSocket(c: RealtimeConnectionOptions): new (url: string) => { onopen: (() => void) | null; onclose: (() => void) | null; onmessage: ((ev: { data?: string }) => void) | null; onerror: (() => void) | null; close: () => void; readyState: number } {
  if (c.WebSocketCtor) return c.WebSocketCtor as never;
  return (globalThis as unknown as { WebSocket: new (url: string) => never }).WebSocket;
}

export function runRealtimeConnection(opts: RealtimeConnectionOptions): RealtimeConnection {
  if (!opts.tenantId) {
    return { dispose: () => undefined };
  }
  const WS = pickWebSocket(opts);
  const setT = opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
  const clearT = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let ws: { onopen: (() => void) | null; onclose: (() => void) | null; onmessage: ((ev: { data?: string }) => void) | null; onerror: (() => void) | null; close: () => void; readyState: number } | null = null;
  let closed = false;
  let retry = 0;
  let timer: unknown = null;
  let hasOpened = false;

  function connect() {
    if (closed) return;
    const proto = (globalThis as unknown as { window: { location: { protocol: string } } }).window?.location?.protocol === "https:" ? "wss" : "ws";
    const host = (globalThis as unknown as { window: { location: { host: string } } }).window?.location?.host ?? "test";
    ws = new WS(`${proto}://${host}/ws?tenantId=${encodeURIComponent(opts.tenantId!)}`);

    ws.onopen = () => {
      const isReconnect = hasOpened;
      hasOpened = true;
      retry = 0;
      if (isReconnect) {
        try {
          opts.onReconnect?.();
        } catch {
          // The recovery callback must not break the socket lifecycle.
        }
      }
    };
    ws.onmessage = (ev) => {
      try {
        opts.onEvent(JSON.parse(ev.data ?? "null"));
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      timer = setT(connect, 500 * 2 ** retry);
    };
    ws.onerror = () => ws?.close();
  }

  connect();

  return {
    dispose: () => {
      closed = true;
      clearT(timer);
      try {
        if (ws && ws.readyState !== 3) ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}

// Reference WS_OPEN to keep parity with the production hook (and the
// upstream "readyState open" sentinel). Not used in this loop because we
// only inspect the WS in tests.
export const _WS_OPEN = WS_OPEN;
