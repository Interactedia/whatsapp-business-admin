import crypto from "node:crypto";

export const WEBHOOK_SIGNATURE_VERSION = "v1";
export const WEBHOOK_SIGNATURE_HEADER = "X-WBA-Signature";
export const WEBHOOK_TIMESTAMP_HEADER = "X-WBA-Timestamp";

export function signWebhookBody(body: string | Buffer, secret: string, timestamp: number = Math.floor(Date.now() / 1000)) {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  const payload = Buffer.concat([Buffer.from(`${timestamp}.`), bytes]);
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return {
    timestamp: String(timestamp),
    signature: `${WEBHOOK_SIGNATURE_VERSION}=${signature}`,
  };
}

export function verifyWebhookSignature(body: string | Buffer, secret: string, timestampHeader: string | null, signatureHeader: string | null, toleranceSeconds = 300): boolean {
  if (!timestampHeader || !signatureHeader) return false;
  const timestamp = Number(timestampHeader);
  if (!Number.isInteger(timestamp)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > toleranceSeconds) return false;
  const expected = signWebhookBody(body, secret, timestamp).signature;
  const actual = signatureHeader.trim();
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && crypto.timingSafeEqual(expectedBytes, actualBytes);
}
