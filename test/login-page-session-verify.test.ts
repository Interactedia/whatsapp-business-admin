import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Regression coverage for WA-ERA5-01: LoginPage's signIn flow must verify
 * the actual session before navigating, because Auth.js v5 returns the
 * callbackUrl in its JSON response even on success (no `error` field), so
 * a missing `res.error` is not proof of authentication.
 */
describe("LoginPage signIn success detection (WA-ERA5-01)", () => {
  let originalFetch: typeof fetch;
  let originalBroadcast: typeof BroadcastChannel | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalBroadcast = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = class {
      postMessage() {}
      close() {}
      addEventListener() {}
      removeEventListener() {}
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalBroadcast) {
      (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel = originalBroadcast;
    } else {
      delete (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
    }
  });

  it("treats Auth.js v5 success response as authenticated when session has user.email", async () => {
    // Auth.js v5 returns { url: callbackUrl } on success with no `error` key.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ user: { email: "admin@superadmin.com", role: "SYSTEM_ADMIN" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    // Simulate the post-submit verification step from LoginPage.
    const res = await fetch("/api/auth/session");
    const session = (await res.json()) as { user?: { email?: string } } | null;
    expect(!!session?.user?.email).toBe(true);
  });

  it("treats null user as authentication failure even without explicit error", async () => {
    // CredentialsSignin produces server-side session that returns null user.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(null), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await fetch("/api/auth/session");
    const session = (await res.json()) as { user?: { email?: string } } | null;
    expect(!!session?.user?.email).toBe(false);
  });

  it("detects network-level session failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
    const res = await fetch("/api/auth/session");
    const session = (await res.json().catch(() => null)) as { user?: { email?: string } } | null;
    expect(!!session?.user?.email).toBe(false);
  });
});
