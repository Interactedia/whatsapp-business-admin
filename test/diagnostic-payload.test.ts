import { describe, expect, it } from "vitest";
import { boundedPayload, payloadExpiresAt, redactSecrets, safeHeaders } from "@/lib/diagnostics/payload";

describe("diagnostic payload security", () => {
  it("redacts credential-bearing keys anywhere in the tree", () => {
    const out = redactSecrets({
      accessToken: "secret-x",
      nested: { api_key: "k", refreshToken: "r" },
      list: [{ clientSecret: "s" }, { ok: true }],
    }) as Record<string, unknown>;
    expect(out.accessToken).toBe("[redacted]");
    expect((out.nested as Record<string, unknown>).api_key).toBe("[redacted]");
    expect((out.nested as Record<string, unknown>).refreshToken).toBe("[redacted]");
    expect((out.list as Record<string, unknown>[])[0].clientSecret).toBe("[redacted]");
    expect((out.list as Record<string, unknown>[])[1].ok).toBe(true);
  });

  it("keeps payloads below 64 KiB intact and marks them not truncated", () => {
    const small = { to: "521999", text: { body: "x".repeat(50_000) } };
    const result = boundedPayload(small);
    expect(result.truncated).toBe(false);
    expect(JSON.stringify(result.value)).toContain("x");
  });

  it("truncates payloads above 64 KiB and marks truncation metadata", () => {
    const large = { blob: "x".repeat(80_000) };
    const result = boundedPayload(large);
    expect(result.truncated).toBe(true);
    const stored = result.value as { truncated: boolean; bytes: number; preview: string };
    expect(stored.truncated).toBe(true);
    expect(stored.bytes).toBeGreaterThan(64 * 1024);
    expect(Buffer.byteLength(stored.preview, "utf8")).toBeLessThanOrEqual(64 * 1024);
  });

  it("exposes only safe headers", () => {
    const h = new Headers({
      "content-type": "application/json",
      accept: "*/*",
      "user-agent": "test",
      authorization: "Bearer t",
      cookie: "sid=abc",
      "x-hub-signature-256": "sha256=...",
    });
    const out = safeHeaders(h);
    expect(out).toEqual({ "content-type": "application/json", accept: "*/*", "user-agent": "test" });
  });

  it("computes payloadExpiresAt 30 days from now", () => {
    const before = Date.now();
    const expires = payloadExpiresAt();
    const diff = expires.getTime() - before;
    expect(diff).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    expect(diff).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000);
  });
});
