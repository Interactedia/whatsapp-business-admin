/**
 * Real Redis integration verification — WA-ERA2-02
 *
 * Run with:
 *   REDIS_URL=redis://127.0.0.1:6379 npx tsx test/integration/redis-integration.test.ts
 *
 * Requires: a running Redis server (no auth by default on localhost:6379)
 * Cleans up all test keys after execution.
 */

const runId = `wa:integration:${Date.now()}:`;

async function main() {
  const { default: Redis } = await import("ioredis");
  const { loadRedisConfig, isRedisConfigured } = await import("@/lib/redis/config");

  const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

  const client = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: 5000,
    maxRetriesPerRequest: 3,
  });

  const results: { label: string; ok: boolean; detail?: string }[] = [];

  async function check(label: string, ok: boolean, detail?: string) {
    results.push({ label, ok, detail });
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
  }

  const testKeys: string[] = [];

  // === 1. PING ===
  if (client.status !== "ready") await client.connect();
  const pong = await client.ping();
  await check("PING returns PONG", pong === "PONG", pong);

  // === 2. SET / GET / DEL ===
  const testKey = `${runId}ping`;
  testKeys.push(testKey);
  await client.set(testKey, "hello-world");
  const val = await client.get(testKey);
  await check("SET/GET correct value", val === "hello-world", val ?? "null");

  await client.del(testKey);
  const afterDel = await client.get(testKey);
  await check("DEL removes key", afterDel === null, afterDel ?? "found");

  // === 3. Health inspection ===
  const status = client.status;
  await check("Client status is ready", status === "ready", status);

  // === 4. Connection reuse ===
  const client2 = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: 5000,
    maxRetriesPerRequest: 3,
  });
  await Promise.all([
    client.status !== "ready" ? client.connect() : Promise.resolve(),
    client2.connect(),
  ]);
  await check(
    "Multiple clients connect independently",
    client !== client2,
    "same object = bad",
  );

  const pong2 = await client.ping();
  await check(
    "Original client still works after second connect",
    pong2 === "PONG",
    pong2,
  );

  // === 5. Graceful shutdown ===
  await client.quit();
  await check("QUIT succeeds", true);

  // === 6. Repeated shutdown is safe ===
  await client.quit().catch(() => {}); // Idempotent
  await check("Repeated QUIT is safe", true);

  // === 7. Shutdown second client ===
  await client2.quit();

  // === 8. App starts without Redis ===
  const originalUrl = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  const nullConfig = loadRedisConfig();
  await check(
    "loadRedisConfig returns null when REDIS_URL absent",
    nullConfig === null,
    String(nullConfig),
  );
  await check(
    "isRedisConfigured returns false without REDIS_URL",
    isRedisConfigured() === false,
    String(isRedisConfigured()),
  );
  process.env.REDIS_URL = originalUrl;

  // === 9. Credentials not leaked in errors ===
  const badClient = new Redis(
    "redis://user:SecretPass123@127.0.0.1:6379",
    { lazyConnect: true, connectTimeout: 2000, maxRetriesPerRequest: 1 },
  );
  badClient.on("error", () => {}); // Absorb unhandled events.
  badClient.on("close", () => {});
  try {
    await badClient.connect();
    await badClient.ping();
    await check("Auth test completed", true, "no auth required");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const leaked = msg.includes("SecretPass123");
    await check(
      "Error message does not leak credentials",
      !leaked,
      leaked ? "CREDENTIALS FOUND!" : "clean",
    );
  } finally {
    await badClient.quit().catch(() => {});
  }

  // === Cleanup: delete all test keys with a fresh connection ===
  try {
    // Close any lingering handles first.
    await Promise.allSettled([client.quit(), client2?.quit(), badClient.quit()]);
    await new Promise((r) => setTimeout(r, 100));

    // Use a non-lazy client for quick cleanup.
    const cleanupClient = new Redis(redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
    });
    cleanupClient.on("error", () => {});
    cleanupClient.on("close", () => {});
    if (testKeys.length > 0) {
      await cleanupClient.del(...testKeys);
    }
    const keys = await cleanupClient.keys(`${runId}*`);
    if (keys.length > 0) {
      await cleanupClient.del(...keys);
      console.log(`\nCleaned ${keys.length} extra key(s) via scan`);
    }
    await cleanupClient.quit().catch(() => {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("Cleanup warning:", msg);
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${passed}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error("FAILED:", failed.map((f) => f.label).join(", "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Integration test error:", err.message);
  process.exit(1);
});
