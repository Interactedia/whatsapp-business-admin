# ERA 2 — Redis Infrastructure Foundation

**Task ID:** WA-ERA2-02-REDIS-FOUNDATION
**Status:** Implemented
**Date:** 2026-10-10
**Scope:** Redis client infrastructure, connection lifecycle, health inspection, and graceful shutdown for future BullMQ integration.

---

## 1. Implemented Behavior

### 1.1 Redis Client Library

| Component | File | Responsibility |
|---|---|---|
| Configuration | `src/lib/redis/config.ts` | Environment loading, validation, typed config |
| Connection management | `src/lib/redis/client.ts` | Lazy singleton, connect, disconnect |
| Health inspection | `src/lib/redis/health.ts` | Programmatic PING check with timeout |
| Public API | `src/lib/redis/index.ts` | Re-exports for consumers |

**Dependency:** `ioredis ^6.0.0`

### 1.2 Connection Lifecycle

- **Lazy initialization:** No network connection is established at module import. The client is created on the first call to `getRedis()`.
- **Singleton:** A single client instance is shared across all consumers via `globalThis.__waRedis`.
- **Server-only:** The client uses `lazyConnect: true` and is never created in Edge runtime code.
- **Bounded retries:** Transient failures retry up to `REDIS_MAX_RETRIES` times (default: 3) with capped exponential backoff (max 10s).
- **No connection per request:** The singleton ensures one connection per Node.js process.

### 1.3 Configuration

```env
# Required only when BullMQ queues are enabled.
REDIS_URL=redis://localhost:6379

# Optional overrides:
REDIS_CONNECT_TIMEOUT_MS=5000
REDIS_MAX_RETRIES=3
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `REDIS_URL` | No | — | When absent, Redis is inactive and all Redis APIs return `null` or degraded results |
| `REDIS_CONNECT_TIMEOUT_MS` | No | `5000` | Connection timeout in milliseconds |
| `REDIS_MAX_RETRIES` | No | `3` | Maximum retry attempts on transient failure. `0` = fail immediately |

**Credentials are never logged.** Invalid URLs produce `RedisConfigurationError` with a redacted message.

### 1.4 Health Inspection

`checkRedisHealth(timeoutMs?)` returns:

```ts
{ status: "ok", latencyMs: number }
{ status: "unavailable", reason: "not_configured" | "not_connected" | "timeout" | "error", message: string }
```

No HTTP endpoint is exposed by this foundation. Callers integrate the health function into their own monitoring.

### 1.5 Graceful Shutdown

```ts
import { disconnectRedis } from "@/lib/redis";

// In a standalone worker or test cleanup:
await disconnectRedis();
```

- Safe to call multiple times.
- Calls `client.quit()` to drain in-flight commands.
- Forces `disconnect()` if `quit()` times out.
- Clears the singleton so `getRedis()` reconnects cleanly on next use.

**Future standalone workers must invoke `disconnectRedis()` on SIGTERM/SIGINT before exiting.**

---

## 2. What Was NOT Implemented

The following are explicitly out of scope for this foundation task and belong to subsequent ERA 2 tasks:

| Out-of-scope item | Future task |
|---|---|
| BullMQ installation | WA-ERA2-03-BULLMQ-INFRASTRUCTURE |
| Queue definitions (wa-webhook-inbound, wa-message-outbound, etc.) | Subsequent ERA 2 tasks |
| BullMQ workers | Subsequent ERA 2 tasks |
| Transactional outbox vs direct enqueue | Outstanding decision — do not resolve here |
| FIFO ordering boundaries | Outstanding decision — do not resolve here |
| Queue failure/recovery strategy | Outstanding decision — do not resolve here |
| Redis-based caching | Future task |
| Redis-based sessions | Future task |

---

## 3. Security Considerations

1. **Server-side only:** `REDIS_URL` is never exposed through `NEXT_PUBLIC` variables.
2. **Credential redaction:** Error messages and health results never contain passwords or usernames from `REDIS_URL`.
3. **No arbitrary Redis commands:** The public API does not expose raw Redis methods. Future consumers (BullMQ) use their own interfaces.
4. **Tenant isolation:** Redis credentials are process-level; individual tenant context is managed at the BullMQ worker level in subsequent tasks.

---

## 4. Native Deployment Requirements

Redis must be installed on the host machine. This is an **operational prerequisite**, not a code dependency.

**Minimal setup (development):**
```bash
# Ubuntu/Debian
sudo apt install redis-server
sudo systemctl start redis-server

# macOS
brew install redis
brew services start redis
```

**Recommended production setup:**
- Redis persistence (RDB or AOF) for restart survival.
- TLS termination if Redis is on a different host.
- Password authentication via `REDIS_URL=redis://user:password@host:port`.
- Monitored via `checkRedisHealth()` or an external health endpoint.

**No Docker dependency:** In accordance with ADR-0003, Redis must be installed as a native service, not containerized.

---

## 5. Design Rationale

### Lazy initialization
Prevents Redis from blocking app startup when `REDIS_URL` is absent. The application starts and runs normally without Redis.

### Singleton on globalThis
Mirrors the `prisma.ts` pattern (`globalThis.prisma`). Ensures Next.js route handlers (in a separate module graph from `server.ts`) share the same Redis connection as the custom server.

### Bounded retry with null on exhausted
The retry strategy returns `null` after `maxRetries`, preventing unbounded reconnect attempts that could block process startup.

### RedisConfigurationError
Provides actionable errors (invalid URL format) without leaking credentials into logs.

---

## 6. Testing

| Test file | Coverage |
|---|---|
| `src/lib/redis/__tests__/config.test.ts` | Valid/missing/invalid config, credential redaction, retry bounds |
| `src/lib/redis/__tests__/client.test.ts` | Lazy init, singleton reuse, connect/disconnect idempotency |
| `src/lib/redis/__tests__/health.test.ts` | Ok/unavailable states, timeout, credential redaction |

All unit tests mock ioredis and do not require a live Redis instance.

---

## 7. Future BullMQ Integration Boundaries

When BullMQ is introduced in WA-ERA2-03:

1. Import the shared client from `@/lib/redis` instead of creating a new `ioredis` instance.
2. Register `disconnectRedis()` in the worker shutdown handler.
3. Set `REDIS_URL` in the environment to activate queue processing.
4. Until `REDIS_URL` is set, the application continues to function without queues.

The outstanding distributed-consistency decisions (outbox vs direct enqueue, FIFO boundaries, failure strategy) must be resolved before enabling durable message-processing behavior.
