/**
 * Unit tests for the Pub/Sub distribution adapter.
 *
 * These tests use injected mock clients (no real Redis). They cover:
 *  - Channel naming (tenant and global)
 *  - Envelope encoding/decoding
 *  - Malformed envelope rejection
 *  - publishToRedis() behavior on success and on publisher error
 *  - Loop prevention: subscriber ignores messages whose origin matches the
 *    local instanceId
 *  - Shutdown idempotency
 *
 * The multi-instance integration test (with real Redis) lives in
 * test/integration/realtime-fanout.test.ts and is the authoritative
 * evidence for cross-process fan-out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock ioredis BEFORE distribution.ts imports it. We capture every
// constructor invocation and the "on" handler bindings so tests can
// drive the message handler without a real socket.
//
// The mock class IS the fake client — every method is a real vi.fn so
// the tests can assert on the methods directly.
type Binding = { event: string; fn: (...args: unknown[]) => void };
type FakeClient = {
  publish: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  psubscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  punsubscribe: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  status: string;
  _bindings: Binding[];
};

function makeFakeClient(): FakeClient {
  const bindings: Binding[] = [];
  const on = vi.fn((event: string, fn: (...args: unknown[]) => void) => {
    bindings.push({ event, fn });
  });
  return {
    publish: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue(1),
    psubscribe: vi.fn().mockResolvedValue(1),
    unsubscribe: vi.fn().mockResolvedValue(1),
    punsubscribe: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue("OK"),
    disconnect: vi.fn(),
    on,
    off: vi.fn(),
    status: "ready",
    _bindings: bindings,
  };
}

const ioredisInstances: FakeClient[] = [];

vi.mock("ioredis", () => {
  return {
    default: class {
      declare publish: ReturnType<typeof vi.fn>;
      declare subscribe: ReturnType<typeof vi.fn>;
      declare psubscribe: ReturnType<typeof vi.fn>;
      declare unsubscribe: ReturnType<typeof vi.fn>;
      declare punsubscribe: ReturnType<typeof vi.fn>;
      declare quit: ReturnType<typeof vi.fn>;
      declare disconnect: ReturnType<typeof vi.fn>;
      declare on: ReturnType<typeof vi.fn>;
      declare off: ReturnType<typeof vi.fn>;
      status: string;
      _bindings: Binding[];
      constructor() {
        const fake = makeFakeClient();
        ioredisInstances.push(fake);
        this.publish = fake.publish;
        this.subscribe = fake.subscribe;
        this.psubscribe = fake.psubscribe;
        this.unsubscribe = fake.unsubscribe;
        this.punsubscribe = fake.punsubscribe;
        this.quit = fake.quit;
        this.disconnect = fake.disconnect;
        this.on = fake.on;
        this.off = fake.off;
        this.status = fake.status;
        this._bindings = fake._bindings;
      }
    },
  };
});

const mockLoadConfig = vi.fn();
const mockIsConfigured = vi.fn();

vi.mock("@/lib/redis/config", () => ({
  loadRedisConfig: () => mockLoadConfig(),
  isRedisConfigured: () => mockIsConfigured(),
  RedisConfigurationError: class extends Error {},
}));

import {
  channelForEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  getPubSubState,
  initRealtimeDistribution,
  publishToRedis,
  setPubSubState,
  shutdownRealtimeDistribution,
  tenantChannel,
  globalChannel,
  type RealtimeEnvelope,
} from "@/lib/realtime/distribution";

beforeEach(() => {
  ioredisInstances.length = 0;
  setPubSubState(null);
  vi.clearAllMocks();
});

afterEach(async () => {
  await shutdownRealtimeDistribution();
});

describe("channel naming", () => {
  it("uses wa:realtime:tenant:<id> for tenant events", () => {
    expect(tenantChannel("acme")).toBe("wa:realtime:tenant:acme");
  });

  it("uses wa:realtime:global for global events", () => {
    expect(globalChannel()).toBe("wa:realtime:global");
  });

  it("channelForEnvelope dispatches by tenantId presence", () => {
    const tenantEnv: RealtimeEnvelope = {
      origin: "a",
      tenantId: "t1",
      event: { type: "x", payload: {} },
    };
    const globalEnv: RealtimeEnvelope = {
      origin: "a",
      tenantId: null,
      event: { type: "x", payload: {} },
    };
    expect(channelForEnvelope(tenantEnv)).toBe("wa:realtime:tenant:t1");
    expect(channelForEnvelope(globalEnv)).toBe("wa:realtime:global");
  });
});

describe("envelope encode/decode", () => {
  it("round-trips a valid envelope", () => {
    const env: RealtimeEnvelope = {
      origin: "instance-a",
      tenantId: "t1",
      event: { type: "message:new", payload: { conversationId: "c1" } },
    };
    const raw = encodeEnvelope(env);
    expect(decodeEnvelope(raw)).toEqual(env);
  });

  it("round-trips a global envelope (tenantId=null)", () => {
    const env: RealtimeEnvelope = {
      origin: "i",
      tenantId: null,
      event: { type: "template:status", payload: { id: 1 } },
    };
    expect(decodeEnvelope(encodeEnvelope(env))).toEqual(env);
  });

  it("rejects non-JSON payloads", () => {
    expect(decodeEnvelope("not-json")).toBeNull();
  });

  it("rejects payloads that are not an object", () => {
    expect(decodeEnvelope("null")).toBeNull();
    expect(decodeEnvelope("123")).toBeNull();
    expect(decodeEnvelope('"hello"')).toBeNull();
    expect(decodeEnvelope("[]")).toBeNull();
  });

  it("rejects envelopes with non-string origin", () => {
    expect(
      decodeEnvelope(
        JSON.stringify({ origin: 1, tenantId: null, event: { type: "x", payload: {} } }),
      ),
    ).toBeNull();
  });

  it("rejects envelopes with empty origin", () => {
    expect(
      decodeEnvelope(
        JSON.stringify({ origin: "", tenantId: null, event: { type: "x", payload: {} } }),
      ),
    ).toBeNull();
  });

  it("rejects envelopes with tenantId that is not string-or-null", () => {
    expect(
      decodeEnvelope(
        JSON.stringify({ origin: "a", tenantId: 42, event: { type: "x", payload: {} } }),
      ),
    ).toBeNull();
  });

  it("rejects envelopes with missing event", () => {
    expect(decodeEnvelope(JSON.stringify({ origin: "a", tenantId: null }))).toBeNull();
  });

  it("rejects envelopes with empty event.type", () => {
    expect(
      decodeEnvelope(
        JSON.stringify({ origin: "a", tenantId: null, event: { type: "", payload: {} } }),
      ),
    ).toBeNull();
  });
});

describe("initRealtimeDistribution", () => {
  it("returns null and creates no clients when Redis is not configured", () => {
    mockIsConfigured.mockReturnValue(false);
    const onMessage = vi.fn();
    const state = initRealtimeDistribution(onMessage);
    expect(state).toBeNull();
    expect(getPubSubState()).toBeNull();
    expect(ioredisInstances).toHaveLength(0);
  });

  it("initializes state with publisher and subscriber when configured", () => {
    mockIsConfigured.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      url: "redis://x",
      options: { connectTimeout: 1000, maxRetriesPerRequest: 1 },
    });
    const onMessage = vi.fn();
    const state = initRealtimeDistribution(onMessage);
    expect(state).not.toBeNull();
    expect(state!.publisher).toBeDefined();
    expect(state!.subscriber).toBeDefined();
    expect(state!.instanceId).toMatch(/^wa-\d+-[a-z0-9]+$/);
    // Two ioredis instances: publisher and subscriber.
    expect(ioredisInstances).toHaveLength(2);
    // Both "message" (exact subscribe) and "pmessage" (pattern subscribe)
    // must be bound on the subscriber. Otherwise tenant traffic delivered
    // via PSUBSCRIBE never reaches the handler.
    const subscriber = ioredisInstances[1];
    const messageBinding = subscriber._bindings.find((b) => b.event === "message");
    const pmessageBinding = subscriber._bindings.find((b) => b.event === "pmessage");
    expect(messageBinding).toBeDefined();
    expect(pmessageBinding).toBeDefined();
    // The wildcard psubscribe and the global subscribe must both fire.
    expect(subscriber.psubscribe).toHaveBeenCalledWith("wa:realtime:*");
    expect(subscriber.subscribe).toHaveBeenCalledWith("wa:realtime:global");
  });

  it("is idempotent: re-calling returns the same state and does not re-create clients", () => {
    mockIsConfigured.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      url: "redis://x",
      options: { connectTimeout: 1000, maxRetriesPerRequest: 1 },
    });
    const first = initRealtimeDistribution(vi.fn());
    const second = initRealtimeDistribution(vi.fn());
    expect(first).toBe(second);
    // No extra ioredis instances created on the second call.
    expect(ioredisInstances).toHaveLength(2);
  });

  it("binds a single 'message' AND a single 'pmessage' handler (no duplicates on re-init)", () => {
    mockIsConfigured.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      url: "redis://x",
      options: { connectTimeout: 1000, maxRetriesPerRequest: 1 },
    });
    initRealtimeDistribution(vi.fn());
    initRealtimeDistribution(vi.fn());
    const subscriber = ioredisInstances[1];
    const messageBindings = subscriber._bindings.filter((b) => b.event === "message");
    const pmessageBindings = subscriber._bindings.filter((b) => b.event === "pmessage");
    expect(messageBindings).toHaveLength(1);
    expect(pmessageBindings).toHaveLength(1);
  });
});

describe("publishToRedis", () => {
  it("returns false when the adapter is not initialized", async () => {
    setPubSubState(null);
    const ok = await publishToRedis({
      origin: "x",
      tenantId: "t1",
      event: { type: "y", payload: {} },
    });
    expect(ok).toBe(false);
  });

  it("publishes to the tenant channel with encoded envelope", async () => {
    mockIsConfigured.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      url: "redis://x",
      options: { connectTimeout: 1000, maxRetriesPerRequest: 1 },
    });
    initRealtimeDistribution(vi.fn());
    const state = getPubSubState()!;
    const env: RealtimeEnvelope = {
      origin: state.instanceId,
      tenantId: "t1",
      event: { type: "message:new", payload: { conversationId: "c1" } },
    };
    const ok = await publishToRedis(env);
    expect(ok).toBe(true);
    expect(state.publisher.publish).toHaveBeenCalledWith(
      "wa:realtime:tenant:t1",
      encodeEnvelope(env),
    );
  });

  it("publishes global events to the global channel", async () => {
    mockIsConfigured.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      url: "redis://x",
      options: { connectTimeout: 1000, maxRetriesPerRequest: 1 },
    });
    initRealtimeDistribution(vi.fn());
    const state = getPubSubState()!;
    const env: RealtimeEnvelope = {
      origin: state.instanceId,
      tenantId: null,
      event: { type: "template:status", payload: { id: 1 } },
    };
    await publishToRedis(env);
    expect(state.publisher.publish).toHaveBeenCalledWith(
      "wa:realtime:global",
      expect.any(String),
    );
  });

  it("returns false and logs when the publisher throws", async () => {
    mockIsConfigured.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      url: "redis://x",
      options: { connectTimeout: 1000, maxRetriesPerRequest: 1 },
    });
    initRealtimeDistribution(vi.fn());
    const state = getPubSubState()!;
    (state.publisher.publish as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("connection refused"),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ok = await publishToRedis({
      origin: state.instanceId,
      tenantId: "t1",
      event: { type: "x", payload: {} },
    });
    expect(ok).toBe(false);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("loop prevention (subscriber behavior)", () => {
  function getInboundHandler() {
    const subscriber = ioredisInstances[1];
    // Both "message" and "pmessage" handlers are the same function; pulling
    // either gives us the inbound dispatch.
    const messageBinding = subscriber._bindings.find((b) => b.event === "message");
    const pmessageBinding = subscriber._bindings.find((b) => b.event === "pmessage");
    expect(messageBinding).toBeDefined();
    expect(pmessageBinding).toBeDefined();
    return messageBinding!.fn as (channel: string, raw: string) => void;
  }

  it("does NOT call the message handler when origin matches the local instanceId", () => {
    mockIsConfigured.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      url: "redis://x",
      options: { connectTimeout: 1000, maxRetriesPerRequest: 1 },
    });
    const onMessage = vi.fn();
    const state = initRealtimeDistribution(onMessage);
    expect(state).not.toBeNull();
    const handler = getInboundHandler();

    // Inbound from a peer instance via exact channel (global): should be delivered.
    const peerEnv: RealtimeEnvelope = {
      origin: "peer-instance",
      tenantId: "t1",
      event: { type: "x", payload: {} },
    };
    handler("wa:realtime:tenant:t1", encodeEnvelope(peerEnv));
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(peerEnv, "wa:realtime:tenant:t1");

    // Inbound from our own instance: should be skipped (echo protection).
    const echoEnv: RealtimeEnvelope = {
      origin: state!.instanceId,
      tenantId: "t1",
      event: { type: "x", payload: {} },
    };
    handler("wa:realtime:tenant:t1", encodeEnvelope(echoEnv));
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("delivers tenant events arriving via pmessage (psubscribe pattern)", () => {
    mockIsConfigured.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      url: "redis://x",
      options: { connectTimeout: 1000, maxRetriesPerRequest: 1 },
    });
    const onMessage = vi.fn();
    initRealtimeDistribution(onMessage);
    // The pmessage handler has signature (pattern, channel, message) and
    // forwards the channel + message to the same dispatch path.
    const pmessageBinding = ioredisInstances[1]._bindings.find(
      (b) => b.event === "pmessage",
    );
    expect(pmessageBinding).toBeDefined();
    const pmessageHandler = pmessageBinding!.fn as (
      pattern: string,
      channel: string,
      raw: string,
    ) => void;
    const env: RealtimeEnvelope = {
      origin: "peer",
      tenantId: "t1",
      event: { type: "x", payload: {} },
    };
    pmessageHandler("wa:realtime:*", "wa:realtime:tenant:t1", encodeEnvelope(env));
    expect(onMessage).toHaveBeenCalledWith(env, "wa:realtime:tenant:t1");
  });

  it("drops malformed envelopes without invoking the message handler", () => {
    mockIsConfigured.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      url: "redis://x",
      options: { connectTimeout: 1000, maxRetriesPerRequest: 1 },
    });
    const onMessage = vi.fn();
    initRealtimeDistribution(onMessage);
    const handler = getInboundHandler();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    handler("wa:realtime:tenant:t1", "not-json");
    handler(
      "wa:realtime:tenant:t1",
      JSON.stringify({ origin: "", tenantId: null, event: { type: "x" } }),
    );
    expect(onMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("isolates a handler crash: subsequent messages still reach onMessage", () => {
    mockIsConfigured.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      url: "redis://x",
      options: { connectTimeout: 1000, maxRetriesPerRequest: 1 },
    });
    const onMessage = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockImplementation(() => {});
    initRealtimeDistribution(onMessage);
    const handler = getInboundHandler();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    handler(
      "wa:realtime:tenant:t1",
      encodeEnvelope({
        origin: "peer",
        tenantId: "t1",
        event: { type: "x", payload: {} },
      }),
    );
    handler(
      "wa:realtime:tenant:t1",
      encodeEnvelope({
        origin: "peer",
        tenantId: "t1",
        event: { type: "y", payload: {} },
      }),
    );
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("shutdownRealtimeDistribution", () => {
  it("is a no-op when the adapter is not initialized", async () => {
    setPubSubState(null);
    await expect(shutdownRealtimeDistribution()).resolves.toBeUndefined();
  });

  it("quits the subscriber and publisher and clears state", async () => {
    mockIsConfigured.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      url: "redis://x",
      options: { connectTimeout: 1000, maxRetriesPerRequest: 1 },
    });
    initRealtimeDistribution(vi.fn());
    const subscriber = ioredisInstances[1];
    const publisher = ioredisInstances[0];
    await shutdownRealtimeDistribution();
    expect(subscriber.quit).toHaveBeenCalled();
    expect(publisher.quit).toHaveBeenCalled();
    expect(getPubSubState()).toBeNull();
  });

  it("is idempotent: calling shutdown twice is safe", async () => {
    mockIsConfigured.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      url: "redis://x",
      options: { connectTimeout: 1000, maxRetriesPerRequest: 1 },
    });
    initRealtimeDistribution(vi.fn());
    await shutdownRealtimeDistribution();
    await expect(shutdownRealtimeDistribution()).resolves.toBeUndefined();
    expect(getPubSubState()).toBeNull();
  });
});
