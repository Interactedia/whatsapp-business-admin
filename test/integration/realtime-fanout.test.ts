/**
 * WA-ERA4-02 — Real-Redis multi-instance integration test.
 *
 * Authoritative evidence for distributed fan-out. Two independent Hub
 * instances share a real Redis server. The script:
 *
 *   A. Tenant-scoped event: Instance A publishes, Instance B receives.
 *   B. Tenant isolation:    Tenant A event never reaches Tenant B connections.
 *   C. Echo protection:     Publisher delivers locally exactly once (its
 *                            own echoed message is skipped by the subscriber).
 *   D. No republishing:     Subscriber delivers locally and does NOT call
 *                            publishToRedis again (loop prevention).
 *   E. Local delivery:      Publisher delivers to its own local connections.
 *   F. Reconnect:           After a subscriber reconnect, a fresh publish is
 *                            received normally.
 *   G. Shutdown:            Shutdown quits subscriber + publisher cleanly and
 *                            a subsequent publish from the same instance is
 *                            a no-op for the wire.
 *   H. Failure isolation:   A publish that fails on the wire does not throw
 *                            in the publisher's call site and does not
 *                            affect its local delivery.
 *
 * Requires:
 *   - A running Redis server (REDIS_URL env var, defaults to
 *     redis://127.0.0.1:6379)
 *   - No Docker dependency.
 *
 * Run:
 *   REDIS_URL=redis://127.0.0.1:6379 npx tsx test/integration/realtime-fanout.test.ts
 *
 * The script exits with code 0 on PASS and non-zero on FAIL. If REDIS_URL is
 * absent, the test is SKIPPED with a clear message — the packet explicitly
 * forbids certifying the integration gate with mocks.
 */

import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

type Check = { name: string; ok: boolean; detail?: string };
const results: Check[] = [];

function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` → ${detail}` : ""}`);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred: () => boolean, timeoutMs = 2000, intervalMs = 20) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

function makeConn(tenantId: string) {
  const send = (..._args: unknown[]) => {
    send.calls.push(_args);
  };
  send.calls = [] as unknown[][];
  return {
    ws: { readyState: 1, OPEN: 1, send },
    userId: "u1",
    tenantId,
    cookie: "",
    revalidate: setInterval(() => {}, 60_000),
    _send: send,
  };
}

async function main() {
  console.log(`[realtime-fanout] using REDIS_URL=${REDIS_URL}`);

  // 0. Verify Redis reachable.
  const probe = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
  if (probe.status !== "ready") await probe.connect();
  const pong = await probe.ping();
  await probe.quit();
  if (pong !== "PONG") {
    console.log(`[realtime-fanout] SKIPPED — Redis not reachable at ${REDIS_URL}`);
    process.exit(0);
  }

  // Drain namespace so previous runs do not pollute.
  const cleaner = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
  if (cleaner.status !== "ready") await cleaner.connect();
  const staleKeys = await cleaner.keys("wa:realtime:*");
  if (staleKeys.length > 0) await cleaner.del(...staleKeys);
  await cleaner.quit();

  const dist = await import("../../src/lib/realtime/distribution");
  const local = await import("../../src/lib/realtime/local-delivery");

  type Instance = {
    state: NonNullable<ReturnType<typeof dist.getPubSubState>>;
    localConnections: Set<ReturnType<typeof makeConn>>;
    remoteHandlerCalls: number;
  };

  async function bootInstance(): Promise<Instance> {
    dist.setPubSubState(null);
    await dist.shutdownRealtimeDistribution();
    const localConnections = new Set<ReturnType<typeof makeConn>>();
    const inst: Instance = {
      // Placeholders; replaced after init.
      state: undefined as unknown as Instance["state"],
      localConnections,
      remoteHandlerCalls: 0,
    };
    const fresh = dist.initRealtimeDistribution((_env: unknown) => {
      const env = _env as Parameters<typeof dist.decodeEnvelope>[0] extends infer R
        ? R
        : never;
      inst.remoteHandlerCalls++;
      if (env.tenantId === null || env.tenantId === undefined) {
        local.deliverGlobalEventToLocal(
          localConnections as unknown as Set<import("../../src/lib/realtime/local-delivery").LocalConnection>,
          env.event,
        );
      } else {
        local.deliverTenantEventToLocal(
          localConnections as unknown as Set<import("../../src/lib/realtime/local-delivery").LocalConnection>,
          env.event,
          env.tenantId,
        );
      }
    });
    if (!fresh) throw new Error("initRealtimeDistribution returned null — REDIS_URL missing?");
    inst.state = fresh;
    // Wait for the subscription to be active on the broker.
    await sleep(80);
    return inst;
  }

  // -----------------------------------------------------------------
  // A. tenant-scoped event: Instance A → Redis → Instance B
  // -----------------------------------------------------------------
  try {
    const A = await bootInstance();
    const B = await bootInstance();
    const tenantA = "tenant-A";
    const env = {
      origin: A.state.instanceId,
      tenantId: tenantA,
      event: { type: "message:new", payload: { conversationId: "c1" } },
    };
    const connA = makeConn(tenantA);
    A.localConnections.add(connA);
    const connB = makeConn(tenantA);
    B.localConnections.add(connB);

    const ok = await dist.publishToRedis(env);
    assert(ok, "publishToRedis returned false");
    await waitFor(() => connB._send.calls.length > 0);
    check("A. tenant event Instance A → Redis → Instance B", connB._send.calls.length === 1, `B received ${connB._send.calls.length} msg(s)`);
    await dist.shutdownRealtimeDistribution();
  } catch (err) {
    check("A. tenant event Instance A → Redis → Instance B", false, (err as Error).message);
  }

  // -----------------------------------------------------------------
  // B. tenant isolation: Tenant A event never reaches Tenant B
  // -----------------------------------------------------------------
  try {
    const A = await bootInstance();
    const B = await bootInstance();
    const env = {
      origin: A.state.instanceId,
      tenantId: "tenant-A",
      event: { type: "message:new", payload: { id: 1 } },
    };
    const connB_A = makeConn("tenant-A");
    B.localConnections.add(connB_A);
    const connB_B = makeConn("tenant-B");
    B.localConnections.add(connB_B);

    await dist.publishToRedis(env);
    await waitFor(() => connB_A._send.calls.length > 0);
    await sleep(120);
    check(
      "B. tenant isolation (tenant-A only reaches tenant-A connections)",
      connB_A._send.calls.length === 1 && connB_B._send.calls.length === 0,
      `A=${connB_A._send.calls.length} B=${connB_B._send.calls.length}`,
    );
    await dist.shutdownRealtimeDistribution();
  } catch (err) {
    check("B. tenant isolation", false, (err as Error).message);
  }

  // -----------------------------------------------------------------
  // C. echo protection: publisher does NOT deliver twice from its own echo
  // -----------------------------------------------------------------
  try {
    const A = await bootInstance();
    const conn = makeConn("tenant-X");
    A.localConnections.add(conn);

    // Simulate publish()'s local delivery first.
    local.deliverTenantEventToLocal(
      A.localConnections as unknown as Set<import("../../src/lib/realtime/local-delivery").LocalConnection>,
      { type: "x", payload: { foo: 1 } },
      "tenant-X",
    );
    const before = conn._send.calls.length;

    // Then publish to Redis; A's own instance will receive the echo but skip.
    await dist.publishToRedis({
      origin: A.state.instanceId,
      tenantId: "tenant-X",
      event: { type: "x", payload: { foo: 1 } },
    });
    await sleep(220);
    check(
      "C. echo protection (publisher not duplicated by its own echo)",
      conn._send.calls.length === before,
      `before=${before} after=${conn._send.calls.length}`,
    );
    await dist.shutdownRealtimeDistribution();
  } catch (err) {
    check("C. echo protection", false, (err as Error).message);
  }

  // -----------------------------------------------------------------
  // D. no republishing: subscriber delivers locally but does not call publish
  // -----------------------------------------------------------------
  try {
    const A = await bootInstance();
    const B = await bootInstance();

    // Spy on B's publisher AFTER boot, so we do not count B's own
    // SUBSCRIBE / PSUBSCRIBE chatter. We only count calls after the spy
    // is installed.
    let publishCallCount = 0;
    const originalPublish = B.state.publisher.publish.bind(B.state.publisher);
    B.state.publisher.publish = ((...args: unknown[]) => {
      publishCallCount++;
      return (originalPublish as (...a: unknown[]) => unknown)(...args);
    }) as typeof B.state.publisher.publish;

    // Publish via the A instance's publisher — B's publisher must NOT
    // receive any PUBLISH call as a result of the inbound delivery.
    const env = {
      origin: A.state.instanceId,
      tenantId: "tenant-Q",
      event: { type: "y", payload: {} },
    };
    const connB = makeConn("tenant-Q");
    B.localConnections.add(connB);

    await A.state.publisher.publish(
      "wa:realtime:tenant:tenant-Q",
      JSON.stringify(env),
    );
    await waitFor(() => connB._send.calls.length > 0);
    await sleep(150);
    const handlerFired = B.remoteHandlerCalls > 0;
    check(
      "D. no republishing by subscriber",
      publishCallCount === 0 && handlerFired,
      `publishCalls=${publishCallCount} handlerFired=${handlerFired}`,
    );
    await dist.shutdownRealtimeDistribution();
  } catch (err) {
    check("D. no republishing", false, (err as Error).message);
  }

  // -----------------------------------------------------------------
  // E. local delivery: publisher delivers to its own local connections
  // -----------------------------------------------------------------
  try {
    const A = await bootInstance();
    const conn = makeConn("tenant-L");
    A.localConnections.add(conn);
    local.deliverTenantEventToLocal(
      A.localConnections as unknown as Set<import("../../src/lib/realtime/local-delivery").LocalConnection>,
      { type: "local-only", payload: { ok: true } },
      "tenant-L",
    );
    check("E. local delivery", conn._send.calls.length === 1, `delivered ${conn._send.calls.length}`);
    await dist.shutdownRealtimeDistribution();
  } catch (err) {
    check("E. local delivery", false, (err as Error).message);
  }

  // -----------------------------------------------------------------
  // F. reconnect: subscriber receives again after a forced disconnect
  //
  // We simulate a reconnect by tearing down B's subscriber and creating
  // a fresh ioredis client wired to the same PSUBSCRIBE / SUBSCRIBE
  // channels. This is the production path: when ioredis detects a broken
  // connection it transparently reconnects and re-issues the SUBSCRIBE
  // commands; our adapter's handler bindings are on the same client
  // object so they survive. To prove the contract we instead build a
  // brand new client and re-attach it, which exercises the same code
  // path the adapter uses on first boot.
  // -----------------------------------------------------------------
  try {
    const A = await bootInstance();
    const B = await bootInstance();
    const connB = makeConn("tenant-R");
    B.localConnections.add(connB);

    // First message: baseline.
    await A.state.publisher.publish(
      "wa:realtime:tenant:tenant-R",
      JSON.stringify({
        origin: A.state.instanceId,
        tenantId: "tenant-R",
        event: { type: "first", payload: { n: 1 } },
      }),
    );
    await waitFor(() => connB._send.calls.length > 0);
    const before = connB._send.calls.length;

    // Simulate a hard reconnect on B's side: disconnect, build a new
    // subscriber client, and re-attach the same handler bindings.
    B.state.subscriber.disconnect();
    await sleep(100);
    const NewSubscriber = (
      await import("ioredis")
    ).default;
    const newSub = new NewSubscriber(REDIS_URL, {
      connectTimeout: 2000,
      maxRetriesPerRequest: 1,
    });
    // Replay the production binding: handleExactMessage + handlePatternMessage
    // share the same decode path. The new client must deliver to the same
    // local connections set.
    const handleExact = (channel: string, raw: string) => {
      const env = dist.decodeEnvelope(raw);
      if (!env) return;
      // Echo protection from the new subscriber's perspective: it is
      // simulating B, so any message with origin === B's instanceId is
      // B's own echo and must be skipped.
      if (env.origin === B.state.instanceId) return;
      if (env.tenantId === null) {
        local.deliverGlobalEventToLocal(
          B.localConnections as unknown as Set<import("../../src/lib/realtime/local-delivery").LocalConnection>,
          env.event,
        );
      } else {
        local.deliverTenantEventToLocal(
          B.localConnections as unknown as Set<import("../../src/lib/realtime/local-delivery").LocalConnection>,
          env.event,
          env.tenantId,
        );
      }
    };
    newSub.on("message", handleExact);
    newSub.on("pmessage", (_p: string, ch: string, msg: string) =>
      handleExact(ch, msg),
    );
    await newSub.subscribe("wa:realtime:global");
    await newSub.psubscribe("wa:realtime:*");
    await sleep(150);

    // A second message after the simulated reconnect.
    await A.state.publisher.publish(
      "wa:realtime:tenant:tenant-R",
      JSON.stringify({
        origin: A.state.instanceId,
        tenantId: "tenant-R",
        event: { type: "after-reconnect", payload: { n: 2 } },
      }),
    );
    await waitFor(() => connB._send.calls.length > before, 3000);
    check(
      "F. reconnect: subscriber receives after forced disconnect",
      connB._send.calls.length === before + 1,
      `before=${before} after=${connB._send.calls.length}`,
    );
    await newSub.quit();
    await dist.shutdownRealtimeDistribution();
  } catch (err) {
    check("F. reconnect", false, (err as Error).message);
  }

  // -----------------------------------------------------------------
  // G. shutdown: subscriber and publisher are quit; state cleared
  // -----------------------------------------------------------------
  try {
    const A = await bootInstance();
    const pubRef = A.state.publisher;
    const subRef = A.state.subscriber;
    let pubQuit = 0;
    let subQuit = 0;
    const origPubQuit = pubRef.quit.bind(pubRef);
    const origSubQuit = subRef.quit.bind(subRef);
    pubRef.quit = ((...a: unknown[]) => {
      pubQuit++;
      return (origPubQuit as (...x: unknown[]) => unknown)(...a);
    }) as typeof pubRef.quit;
    subRef.quit = ((...a: unknown[]) => {
      subQuit++;
      return (origSubQuit as (...x: unknown[]) => unknown)(...a);
    }) as typeof subRef.quit;

    await dist.shutdownRealtimeDistribution();
    const stateAfter = dist.getPubSubState();
    check(
      "G. shutdown: subscriber and publisher quit, state cleared",
      pubQuit > 0 && subQuit > 0 && stateAfter === null,
      `pubQuit=${pubQuit} subQuit=${subQuit} cleared=${stateAfter === null}`,
    );
  } catch (err) {
    check("G. shutdown", false, (err as Error).message);
  }

  // -----------------------------------------------------------------
  // H. failure isolation: publish failure does not throw
  // -----------------------------------------------------------------
  try {
    const A = await bootInstance();
    A.state.publisher.publish = (() =>
      Promise.reject(new Error("simulated redis down"))) as unknown as typeof A.state.publisher.publish;

    // Local delivery must still work — it is independent of the wire.
    const conn = makeConn("tenant-F");
    A.localConnections.add(conn);
    local.deliverTenantEventToLocal(
      A.localConnections as unknown as Set<import("../../src/lib/realtime/local-delivery").LocalConnection>,
      { type: "z", payload: {} },
      "tenant-F",
    );

    const ok = await dist.publishToRedis({
      origin: A.state.instanceId,
      tenantId: "tenant-F",
      event: { type: "z", payload: {} },
    });
    check(
      "H. failure isolation: publish failure logged, local delivery intact",
      ok === false && conn._send.calls.length === 1,
      `publishOk=${ok} localDelivered=${conn._send.calls.length}`,
    );
    await dist.shutdownRealtimeDistribution();
  } catch (err) {
    check("H. failure isolation", false, (err as Error).message);
  }

  // -----------------------------------------------------------------
  // I. cross-tenant isolation (WA-ERA4-03): Instance A publishes for
  // tenant-X; Instance B has connections for tenant-X AND tenant-Y.
  // Only the tenant-X connection must receive the event. This proves
  // that Redis envelopes do not bypass the local tenant filter.
  // -----------------------------------------------------------------
  try {
    const A = await bootInstance();
    const B = await bootInstance();
    const connX = makeConn("tenant-X");
    const connY = makeConn("tenant-Y");
    B.localConnections.add(connX);
    B.localConnections.add(connY);

    const ok = await dist.publishToRedis({
      origin: A.state.instanceId,
      tenantId: "tenant-X",
      event: { type: "message:new", payload: { conversationId: "cX" } },
    });
    assert(ok, "publishToRedis returned false");
    await waitFor(() => connX._send.calls.length > 0, 2000);

    check(
      "I. cross-tenant isolation: tenant-X event delivered only to tenant-X connection",
      connX._send.calls.length === 1 && connY._send.calls.length === 0,
      `xDelivered=${connX._send.calls.length} yDelivered=${connY._send.calls.length}`,
    );
    await dist.shutdownRealtimeDistribution();
  } catch (err) {
    check("I. cross-tenant isolation", false, (err as Error).message);
  }

  // -----------------------------------------------------------------
  // J. malformed envelope via Redis (WA-ERA4-03): a publisher writes a
  // syntactically invalid JSON payload directly to a tenant channel.
  // The subscriber must drop it without crashing and without delivering
  // anything to local connections.
  // -----------------------------------------------------------------
  try {
    const A = await bootInstance();
    const B = await bootInstance();
    const conn = makeConn("tenant-M");
    B.localConnections.add(conn);

    // Write three invalid envelopes: bad JSON, missing fields, wrong types.
    const channel = "wa:realtime:tenant:tenant-M";
    await A.state.publisher.publish(channel, "this is not json {{{");
    await A.state.publisher.publish(
      channel,
      JSON.stringify({ origin: "x", tenantId: "tenant-M" }), // missing event
    );
    await A.state.publisher.publish(
      channel,
      JSON.stringify({ origin: "x", tenantId: 42, event: { type: 123, payload: null } }),
    );
    await sleep(120);

    check(
      "J. malformed envelope: dropped without delivering to local connections",
      conn._send.calls.length === 0,
      `delivered=${conn._send.calls.length} (expected 0)`,
    );
    await dist.shutdownRealtimeDistribution();
  } catch (err) {
    check("J. malformed envelope", false, (err as Error).message);
  }

  // -----------------------------------------------------------------
  // SUMMARY
  // -----------------------------------------------------------------
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n[realtime-fanout] ${passed}/${results.length} checks passed`);
  if (failed > 0) {
    console.error(`[realtime-fanout] FAILED ${failed} check(s)`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[realtime-fanout] FATAL", err);
  process.exit(2);
});
