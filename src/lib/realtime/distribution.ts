/**
 * WA-ERA4-02 — Redis Pub/Sub fan-out adapter for the realtime WebSocket Hub.
 *
 * Topology:
 *   - Tenant-scoped events: channel `wa:realtime:tenant:<tenantId>`
 *   - Global events:        channel `wa:realtime:global`
 *
 * Envelope contract (internal — never crosses the WebSocket boundary):
 *   {
 *     origin: string;          // instanceId that originated the publication
 *     tenantId: string | null; // null for global; bound tenant otherwise
 *     event: { type: string; payload: unknown };
 *   }
 *
 * Loop prevention:
 *   The publisher records its instanceId in `origin`. The subscriber ignores
 *   messages whose `origin` matches the local instanceId, so a publisher's own
 *   echoed event is not delivered a second time to its local connections.
 *
 * Failure semantics:
 *   - At-most-once. Redis Pub/Sub does not retain messages.
 *   - Publication failure is logged; it NEVER blocks or reverts the caller's
 *     PostgreSQL commit (publication is best-effort by design).
 *   - Subscriber reconnect is handled by ioredis; a malformed envelope is
 *     logged and dropped without crashing the process.
 *
 * Relationship to BullMQ:
 *   This adapter uses a SEPARATE ioredis client from `src/lib/redis/client.ts`.
 *   ioredis cannot run arbitrary commands on a connection in subscribe mode;
 *   BullMQ's connection must remain untouched. The two are conceptually and
 *   physically isolated.
 */
import Redis, { type Redis as RedisClient } from "ioredis";
import { loadRedisConfig, isRedisConfigured, type RedisConfig } from "@/lib/redis/config";

/** Re-export of the existing RealtimeEvent shape for the fan-out boundary. */
export type RealtimeEvent = {
  type: string;
  payload: unknown;
};

/** Internal envelope used between instances on Redis Pub/Sub. */
export type RealtimeEnvelope = {
  /** Stable instance identifier of the publishing process. */
  origin: string;
  /** Tenant scope. null for global events, a tenant id for tenant-scoped events. */
  tenantId: string | null;
  /** The existing RealtimeEvent (type + payload). */
  event: RealtimeEvent;
};

const TENANT_CHANNEL_PREFIX = "wa:realtime:tenant:";
const GLOBAL_CHANNEL = "wa:realtime:global";
const CHANNEL_PATTERN = "wa:realtime:*";

export function tenantChannel(tenantId: string): string {
  return `${TENANT_CHANNEL_PREFIX}${tenantId}`;
}

export function globalChannel(): string {
  return GLOBAL_CHANNEL;
}

/** Derive the channel name from an envelope — for the subscriber side. */
export function channelForEnvelope(env: RealtimeEnvelope): string {
  if (env.tenantId === null || env.tenantId === undefined) return GLOBAL_CHANNEL;
  return tenantChannel(env.tenantId);
}

type PubSubState = {
  /** Publisher client. Can run arbitrary Redis commands. */
  publisher: RedisClient;
  /** Subscriber client. In subscribe mode; cannot run normal commands. */
  subscriber: RedisClient;
  /** Stable per-process instanceId; reused across reconnects. */
  instanceId: string;
  /** Active subscription. Tracked so we can clean up on shutdown. */
  subscribed: boolean;
  /** Bound message handler — used for tests and clean re-binding. */
  onMessage: ((env: RealtimeEnvelope, channel: string) => void) | null;
};

const g = globalThis as unknown as {
  __waRealtimePubSub?: PubSubState;
};

/**
 * Produce a per-process instanceId. The value is stable for the life of the
 * process so the subscriber can recognize its own echoes.
 */
function ensureInstanceId(): string {
  // crypto.randomUUID is available in Node 24+ and is good enough for an
  // ephemeral process-scoped identifier used only to filter our own echoes.
  // It is NOT a security boundary — it is a loop-prevention tag.
  return `wa-${process.pid}-${Date.now().toString(36)}`;
}

/**
 * Build a fresh subscriber client. ioredis in subscribe mode rejects normal
 * commands, so this connection is dedicated to SUBSCRIBE / PSUBSCRIBE.
 */
function buildSubscriber(cfg: RedisConfig): RedisClient {
  const sub = new Redis(cfg.url, {
    ...cfg.options,
    // The subscriber should keep retrying on transient failures; we do not
    // cap it because reconnects are how ioredis recovers from a Redis restart.
    showFriendlyErrorStack: process.env.NODE_ENV === "development",
  });
  sub.on("error", (err: Error) => {
    // No credentials in err.message; ioredis does not surface URL credentials.
    console.error(`[realtime-pubsub] subscriber error: ${err.message}`);
  });
  sub.on("end", () => {
    console.info("[realtime-pubsub] subscriber connection ended");
  });
  sub.on("reconnecting", () => {
    console.info("[realtime-pubsub] subscriber reconnecting");
  });
  sub.on("ready", () => {
    console.info("[realtime-pubsub] subscriber ready");
  });
  return sub;
}

function buildPublisher(cfg: RedisConfig): RedisClient {
  const pub = new Redis(cfg.url, {
    ...cfg.options,
    showFriendlyErrorStack: process.env.NODE_ENV === "development",
  });
  pub.on("error", (err: Error) => {
    console.error(`[realtime-pubsub] publisher error: ${err.message}`);
  });
  pub.on("reconnecting", () => {
    console.info("[realtime-pubsub] publisher reconnecting");
  });
  return pub;
}

/**
 * Test/inspection helper — returns the live state when present. Used by unit
 * tests to assert lifecycle transitions and by integration tests to wire the
 * subscriber directly without going through initRealtimeDistribution.
 */
export function getPubSubState(): PubSubState | null {
  return g.__waRealtimePubSub ?? null;
}

/**
 * Test/inspection helper — replace the live state. Used by unit tests to
 * inject mocked clients.
 */
export function setPubSubState(state: PubSubState | null): void {
  if (state === null) {
    delete g.__waRealtimePubSub;
    return;
  }
  g.__waRealtimePubSub = state;
}

/**
 * Initialize (or return existing) Pub/Sub adapter. Returns null when Redis
 * is not configured (REDIS_URL absent) so the rest of the system can keep
 * operating in single-process mode without modification.
 *
 * Idempotent: calling initRealtimeDistribution() multiple times returns the
 * same state and does not register duplicate handlers.
 */
export function initRealtimeDistribution(
  onMessage: (env: RealtimeEnvelope, channel: string) => void,
): PubSubState | null {
  if (!isRedisConfigured()) {
    return null;
  }
  if (g.__waRealtimePubSub) {
    // Already initialized. Just rebind the message handler — this is what
    // makes the adapter idempotent across HMR-style re-evaluations.
    g.__waRealtimePubSub.onMessage = onMessage;
    return g.__waRealtimePubSub;
  }

  const cfg = loadRedisConfig();
  if (!cfg) return null;

  const publisher = buildPublisher(cfg);
  const subscriber = buildSubscriber(cfg);

  const state: PubSubState = {
    publisher,
    subscriber,
    instanceId: ensureInstanceId(),
    subscribed: false,
    onMessage,
  };
  g.__waRealtimePubSub = state;

  // Wire the inbound handler. ioredis emits:
  //   - "message"   with (channel, message)         for exact SUBSCRIBE matches
  //   - "pmessage"  with (pattern, channel, message) for pattern matches
  // We need to handle BOTH, otherwise tenant-scoped traffic (delivered via
  // PSUBSCRIBE on the wa:realtime:* pattern) is silently dropped. The two
  // events have different argument shapes, so we adapt to a common
  // (channel, raw) signature before decoding.
  const handleExactMessage = (channel: string, raw: string) => {
    handleInbound(channel, raw);
  };
  const handlePatternMessage = (_pattern: string, channel: string, raw: string) => {
    handleInbound(channel, raw);
  };
  const handleInbound = (channel: string, raw: string) => {
    let env: RealtimeEnvelope | null = null;
    try {
      env = decodeEnvelope(raw);
    } catch (err) {
      console.warn(
        `[realtime-pubsub] decode threw: ${(err as Error).message}; raw=${JSON.stringify(raw).slice(0, 200)}`,
      );
      return;
    }
    if (!env) {
      console.warn(
        `[realtime-pubsub] dropping malformed envelope: raw=${JSON.stringify(raw).slice(0, 200)}`,
      );
      return;
    }
    // Loop prevention: skip messages we originated. The subscriber is still
    // a peer instance from Redis' perspective; the publisher delivered
    // locally already, so delivering the echo would double-send.
    if (env.origin === state.instanceId) return;
    if (state.onMessage) {
      try {
        state.onMessage(env, channel);
      } catch (err) {
        // A handler crash must not take the subscriber down. The next message
        // still needs to be delivered to other healthy connections.
        console.error(
          `[realtime-pubsub] handler error: ${(err as Error).message}`,
        );
      }
    }
  };
  subscriber.on("message", handleExactMessage);
  subscriber.on("pmessage", handlePatternMessage);

  // Subscribe to BOTH the wildcard tenant pattern and the global channel.
  // PSUBSCRIBE is the natural fit because we do not know in advance which
  // tenant channels exist; subscribing per-tenant would require watching
  // every authenticated WebSocket and re-subscribing as connections arrive.
  // The pattern is namespaced (`wa:realtime:*`) so unrelated traffic is
  // ignored.
  void Promise.all([
    subscriber.psubscribe(CHANNEL_PATTERN),
    subscriber.subscribe(GLOBAL_CHANNEL),
  ])
    .then(() => {
      state.subscribed = true;
      console.info(
        `[realtime-pubsub] subscribed (instanceId=${state.instanceId})`,
      );
    })
    .catch((err: Error) => {
      console.error(`[realtime-pubsub] subscribe failed: ${err.message}`);
    });

  return state;
}

/**
 * Validate and decode a raw Pub/Sub message into a RealtimeEnvelope. Returns
 * null for any malformed payload; the caller logs and drops.
 */
export function decodeEnvelope(raw: string): RealtimeEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const { origin, tenantId, event } = obj;
  if (typeof origin !== "string" || origin.length === 0) return null;
  if (tenantId !== null && typeof tenantId !== "string") return null;
  if (!event || typeof event !== "object") return null;
  const ev = event as Record<string, unknown>;
  if (typeof ev.type !== "string" || ev.type.length === 0) return null;
  // The payload is intentionally `unknown` — we do not validate its shape
  // here. Tenant isolation is enforced at the local-delivery layer, which
  // already requires a matching ConnectionInfo.tenantId.
  return {
    origin,
    tenantId: tenantId as string | null,
    event: { type: ev.type, payload: ev.payload },
  };
}

/**
 * Encode an envelope for publication. Returns the JSON string ready to be
 * sent to a Redis channel. Throws on programmer error (missing origin);
 * runtime validation of inbound envelopes is in decodeEnvelope.
 */
export function encodeEnvelope(env: RealtimeEnvelope): string {
  return JSON.stringify(env);
}

/**
 * Publish an event to the appropriate channel. Returns true when the
 * command was queued successfully; false on any failure (logged). Failure
 * NEVER throws — the caller's PostgreSQL commit must not be affected.
 */
export async function publishToRedis(
  env: RealtimeEnvelope,
): Promise<boolean> {
  const state = g.__waRealtimePubSub;
  if (!state) return false;
  const channel = channelForEnvelope(env);
  const payload = encodeEnvelope(env);
  try {
    await state.publisher.publish(channel, payload);
    return true;
  } catch (err) {
    console.error(
      `[realtime-pubsub] publish failed (channel=${channel}): ${(err as Error).message}`,
    );
    return false;
  }
}

/**
 * Release the subscriber and publisher. Safe to call multiple times; safe
 * to call when not initialized. Called from shutdownRealtime() to ensure
 * no Redis handles outlive the process.
 */
export async function shutdownRealtimeDistribution(): Promise<void> {
  const state = g.__waRealtimePubSub;
  if (!state) return;
  delete g.__waRealtimePubSub;
  state.subscribed = false;
  state.onMessage = null;
  try {
    await state.subscriber.quit().catch(() => {
      // quit() rejects when not connected; fall back to disconnect.
      state.subscriber.disconnect();
    });
  } catch (err) {
    console.error(
      `[realtime-pubsub] subscriber shutdown error: ${(err as Error).message}`,
    );
  }
  try {
    await state.publisher.quit().catch(() => {
      state.publisher.disconnect();
    });
  } catch (err) {
    console.error(
      `[realtime-pubsub] publisher shutdown error: ${(err as Error).message}`,
    );
  }
}
