const MAX_BYTES = 64 * 1024;
const RETENTION_DAYS = 30;

const SECRET_KEYS = /authorization|cookie|token|secret|api[-_]?key|password|signature/i;
const SAFE_HEADERS = new Set(["content-type", "accept", "user-agent", "x-request-id"]);

export type StoredPayload = { value: unknown; truncated: boolean };

export function payloadExpiresAt(now = new Date()): Date {
  return new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

export function safeHeaders(headers: Headers | Record<string, string | null | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.toLowerCase();
    if (SAFE_HEADERS.has(key) && rawValue) out[key] = rawValue;
  }
  return out;
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SECRET_KEYS.test(key) ? "[redacted]" : redactSecrets(val);
  }
  return out;
}

export function boundedPayload(value: unknown): StoredPayload {
  const redacted = redactSecrets(value);
  // JSON.stringify(undefined) returns undefined (not a string); Buffer.byteLength
  // would throw ERR_INVALID_ARG_TYPE on it. Body-less Graph requests (GET) hit this.
  const json = JSON.stringify(redacted) ?? "null";
  if (Buffer.byteLength(json, "utf8") <= MAX_BYTES) return { value: redacted, truncated: false };
  return {
    value: { truncated: true, bytes: Buffer.byteLength(json, "utf8"), preview: json.slice(0, MAX_BYTES) },
    truncated: true,
  };
}
