import { describe, expect, it } from "vitest";
import {
  isBroadcastAsyncEnabled,
  WHATSAPP_BROADCAST_ASYNC_ENABLED,
  BROADCAST_DISPATCH_LIMITER,
  DEFAULT_BROADCAST_WORKER_CONCURRENCY,
} from "@/lib/whatsapp/broadcast/config";

describe("broadcast config and feature flag", () => {
  it("defaults to false when environment variable is unset", () => {
    expect(isBroadcastAsyncEnabled({})).toBe(false);
  });

  it("returns true only when explicitly set to 'true'", () => {
    expect(isBroadcastAsyncEnabled({ [WHATSAPP_BROADCAST_ASYNC_ENABLED]: "true" })).toBe(true);
    expect(isBroadcastAsyncEnabled({ [WHATSAPP_BROADCAST_ASYNC_ENABLED]: "TRUE" })).toBe(true);
    expect(isBroadcastAsyncEnabled({ [WHATSAPP_BROADCAST_ASYNC_ENABLED]: "false" })).toBe(false);
    expect(isBroadcastAsyncEnabled({ [WHATSAPP_BROADCAST_ASYNC_ENABLED]: "1" })).toBe(false);
  });

  it("exports valid rate limiter and worker concurrency defaults", () => {
    expect(BROADCAST_DISPATCH_LIMITER.max).toBe(20);
    expect(BROADCAST_DISPATCH_LIMITER.duration).toBe(1000);
    expect(DEFAULT_BROADCAST_WORKER_CONCURRENCY).toBeGreaterThanOrEqual(1);
  });
});
