/**
 * Shared helpers for the WA-ERA3-07 integration certification test.
 */

export const runId = `era3_cert_${Date.now()}`;

export function typeCheck<T>(value: T): T {
  return value;
}
