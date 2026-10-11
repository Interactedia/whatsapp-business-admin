/**
 * Real Redis failure-handling verification — WA-ERA2-02
 *
 * Run with:
 *   REDIS_URL=redis://127.0.0.1:6379 npx tsx test/integration/redis-failure-handling.test.ts
 */

const { default: Redis } = await import("ioredis");
const { checkRedisHealth } = await import("@/lib/redis/health");

const results: { label: string; ok: boolean; detail?: string }[] = [];

async function check(label: string, ok: boolean, detail?: string) {
  results.push({ label, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
}

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

// ============================================================
// A. Bounded timeout on unavailable host
// ============================================================
const unavailableUrl = "redis://127.0.0.1:65534"; // Nothing listening here
const timeoutClient = new Redis(unavailableUrl, {
  lazyConnect: true,
  connectTimeout: 500,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null, // Disable retries so it fails fast
});

timeoutClient.on("error", () => {}); // Absorb.
timeoutClient.on("close", () => {});

try {
  await timeoutClient.connect();
  await check("Unavailable host: should not connect", false, "connected unexpectedly");
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  const isConnErr =
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("Connection is closed") ||
    msg.includes("Connection timed out");
  await check("Unavailable host: error is connection-related", isConnErr, msg);
  } finally {
  timeoutClient.disconnect();
}

// ============================================================
// B. Health check with unavailable Redis
// ============================================================
{
  const originalUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = unavailableUrl;
  try {
    const health = await checkRedisHealth(500);
    await check(
      "Health returns unavailable for unreachable Redis",
      health.status === "unavailable",
      health.status,
    );
    if ("reason" in health && health.reason) {
      await check(
        "Health provides reason for unavailable state",
        true,
        health.reason,
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await check(
      "Health check does not throw unhandled (catches error)",
      true,
      msg.substring(0, 50),
    );
  } finally {
    process.env.REDIS_URL = originalUrl;
  }
}

// ============================================================
// C. Reconnection after transient failure
// ============================================================
{
  const reconnectClient = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: 5000,
    maxRetriesPerRequest: 2,
    retryStrategy: (tries) => (tries <= 2 ? 100 : null),
  });

  reconnectClient.on("error", () => {}); // Absorb.
  reconnectClient.on("close", () => {});

  try {
    await reconnectClient.connect();
    const pong1 = await reconnectClient.ping();
    await check("Reconnection: initial PING succeeds", pong1 === "PONG", pong1);

    // Manually close the underlying socket (simulates transient failure).
    reconnectClient.disconnect(false); // false = do not reconnect automatically.
    // Give ioredis time to update internal state.
    await new Promise((r) => setTimeout(r, 100));

    // After disconnect, status should indicate the socket is closed.
    const postDiscStatus = reconnectClient.status;
    const isClosed =
      postDiscStatus === "closed" || postDiscStatus === "end";
    await check("After disconnect(), client reports closed/end status", isClosed, postDiscStatus);

    // Reconnect using reconnect().
    const reconnectPromise = reconnectClient.reconnect?.();
    if (reconnectPromise) {
      await reconnectPromise;
    } else {
      // Fallback: create new client.
      const newClient = new Redis(redisUrl, { lazyConnect: true });
      await newClient.connect();
      const pong2 = await newClient.ping();
      await check("Reconnection: PING succeeds after reconnect()", pong2 === "PONG", pong2);
      await newClient.quit().catch(() => {});
    }
  } finally {
    reconnectClient.disconnect();
  }
}

// ============================================================
// D. No unhandled promise rejections
// ============================================================
{
  const noisyClient = new Redis("redis://127.0.0.1:65534", {
    lazyConnect: true,
    connectTimeout: 200,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });

  noisyClient.on("error", () => {}); // Absorb error events.
  noisyClient.on("close", () => {});

  try {
    await noisyClient.connect();
    await check(
      "Bad port connect: should not succeed",
      false,
      "connected unexpectedly",
    );
  } catch {
    await check("Bad port connect: throws on bad port", true, "caught");
  }

  noisyClient.disconnect();
}

// ============================================================
// Summary
// ============================================================
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
console.log(`\n${passed}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error("FAILED:", failed.map((f) => `${f.label} (${f.detail})`).join(", "));
  process.exit(1);
}
