import { describe, expect, it, vi, beforeEach } from "vitest";
import { parseCookies, verifySessionToken, type AuthDiagnostic } from "@/lib/auth-token";

vi.mock("next-auth/jwt", () => ({
  decode: vi.fn(),
}));

describe("Realtime Cookie Parsing and Redacted Auth Diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("parseCookies", () => {
    it("handles standard multiple cookie pairs", () => {
      const parsed = parseCookies("foo=bar; baz=qux; hello=world");
      expect(parsed).toEqual({
        foo: "bar",
        baz: "qux",
        hello: "world",
      });
    });

    it("handles quoted cookie values without quotes in output", () => {
      const parsed = parseCookies('authjs.session-token="my-token-value"; theme=dark');
      expect(parsed["authjs.session-token"]).toBe("my-token-value");
      expect(parsed.theme).toBe("dark");
    });

    it("does not split on semicolons contained inside quoted values", () => {
      const parsed = parseCookies('complex="value;with;semicolons"; simple=123');
      expect(parsed.complex).toBe("value;with;semicolons");
      expect(parsed.simple).toBe("123");
    });

    it("handles escaped quotes and backslashes inside quoted values", () => {
      const parsed = parseCookies('escaped="hello \\"world\\" and \\\\slash"; valid=true');
      expect(parsed.escaped).toBe('hello "world" and \\slash');
      expect(parsed.valid).toBe("true");
    });

    it("decodes percent-encoded delimiters and special characters", () => {
      const parsed = parseCookies("encoded=hello%3Bworld%26foo%3Dbar; plain=ok");
      expect(parsed.encoded).toBe("hello;world&foo=bar");
      expect(parsed.plain).toBe("ok");
    });

    it("gracefully falls back when percent encoding is malformed", () => {
      const parsed = parseCookies("malformed=abc%2g123; safe=true");
      expect(parsed.malformed).toBe("abc%2g123");
      expect(parsed.safe).toBe("true");
    });

    it("handles empty or whitespace-only header", () => {
      expect(parseCookies("")).toEqual({});
      expect(parseCookies("   ")).toEqual({});
    });

    it("preserves base64 padding with multiple equals signs", () => {
      const parsed = parseCookies("b64=YWJjZGVmZw==; next=val");
      expect(parsed.b64).toBe("YWJjZGVmZw==");
      expect(parsed.next).toBe("val");
    });
  });

  describe("verifySessionToken with diagnostics", () => {
    it("emits missing_secret diagnostic when AUTH_SECRET is not configured", async () => {
      delete process.env.AUTH_SECRET;
      delete process.env.NEXTAUTH_SECRET;
      const diagnostics: AuthDiagnostic[] = [];
      const session = await verifySessionToken("authjs.session-token=abc", (d) => diagnostics.push(d));

      expect(session).toBeNull();
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.reason).toBe("missing_secret");
    });

    it("emits empty_header diagnostic when header is empty", async () => {
      process.env.AUTH_SECRET = "test-secret";
      const diagnostics: AuthDiagnostic[] = [];
      const session = await verifySessionToken("", (d) => diagnostics.push(d));

      expect(session).toBeNull();
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.reason).toBe("empty_header");
      expect(diagnostics[0]?.cookieNamesPresent).toEqual([]);
    });

    it("emits token_not_found diagnostic with redacted cookie names only", async () => {
      process.env.AUTH_SECRET = "test-secret";
      const diagnostics: AuthDiagnostic[] = [];
      const session = await verifySessionToken("other_cookie=secret123; tracking=xyz", (d) => diagnostics.push(d));

      expect(session).toBeNull();
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.reason).toBe("token_not_found");
      expect(diagnostics[0]?.cookieNamesPresent).toEqual(["other_cookie", "tracking"]);
      // Crucial: ensure values/tokens are NEVER in diagnostic
      expect(JSON.stringify(diagnostics)).not.toContain("secret123");
      expect(JSON.stringify(diagnostics)).not.toContain("xyz");
    });

    it("successfully returns session info when token decodes with sub", async () => {
      process.env.AUTH_SECRET = "test-secret";
      const { decode } = await import("next-auth/jwt");
      vi.mocked(decode).mockResolvedValueOnce({ sub: "user-123", role: "ADMIN" } as unknown as Awaited<ReturnType<typeof decode>>);

      const session = await verifySessionToken('authjs.session-token="quoted-jwt-token"');
      expect(session).toEqual({
        userId: "user-123",
        role: "ADMIN",
      });
    });

    it("emits decode_failed diagnostic when decode throws", async () => {
      process.env.AUTH_SECRET = "test-secret";
      const { decode } = await import("next-auth/jwt");
      vi.mocked(decode).mockRejectedValueOnce(new Error("Invalid token"));

      const diagnostics: AuthDiagnostic[] = [];
      const session = await verifySessionToken("authjs.session-token=malformed-token", (d) => diagnostics.push(d));
      expect(session).toBeNull();
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.reason).toBe("decode_failed");
      expect(JSON.stringify(diagnostics)).not.toContain("malformed-token");
    });
  });
});
