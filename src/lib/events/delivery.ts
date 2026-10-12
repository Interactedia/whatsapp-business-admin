import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { signWebhookBody } from "@/lib/events/webhook-signing";
import type { AnyExternalEvent } from "@/lib/events/contract";
import {
  claimDelivery,
  completeDeliveryAttempt,
  createDeliveryForEvent,
  DEFAULT_DELIVERY_LEASE_MS,
  type DeliveryAttemptResult,
} from "@/lib/events/delivery-state";
import type { DeliveryRetryPolicy } from "@/lib/events/retry-policy";
import { DEFAULT_DELIVERY_MAX_ATTEMPTS, nextRetryDecision } from "@/lib/events/retry-policy";
import type { CanonicalEventOutboxRecord } from "@/lib/events/outbox";
import { listCanonicalEvents, type CanonicalEventPrisma } from "@/lib/events/outbox";
import { validateExternalEvent } from "@/lib/events/validation";

export const DEFAULT_DELIVERY_TIMEOUT_MS = 5_000;
export const MAX_DELIVERY_TIMEOUT_MS = 30_000;
export const DEFAULT_DELIVERY_BATCH_SIZE = 25;
export const DEFAULT_DELIVERY_CONCURRENCY = 3;
export const MAX_DELIVERY_BATCH_SIZE = 100;
export const MAX_DELIVERY_CONCURRENCY = 10;

export interface CanonicalWebhookDestination {
  id: string;
  tenantId: string;
  url: string;
  signingSecret?: string;
}

export type CanonicalDeliveryResult =
  | { status: "accepted"; eventId: string; destinationId: string; tenantId: string; httpStatus: number; retryAfter?: string | null }
  | { status: "rejected"; eventId: string; destinationId: string; tenantId: string; httpStatus: number; retryAfter?: string | null }
  | { status: "network_error"; eventId: string; destinationId: string; tenantId: string; error: string }
  | { status: "timeout"; eventId: string; destinationId: string; tenantId: string; timeoutMs: number }
  | { status: "invalid_destination"; eventId: string; destinationId: string; tenantId: string; reason: string };

export type DurableCanonicalDeliveryResult = CanonicalDeliveryResult & {
  deliveryId?: string;
  attemptNumber?: number;
  finalState?: "ACCEPTED" | "RETRY_PENDING" | "FAILED_TERMINAL";
  nextRetryAt?: Date | null;
};

export interface CanonicalDeliveryWorkerResult {
  tenantId: string;
  destinationId: string;
  requestedBatchSize: number;
  scannedEvents: number;
  results: DurableCanonicalDeliveryResult[];
}

export interface CanonicalDeliveryWorkerOptions {
  tenantId: string;
  destination: CanonicalWebhookDestination;
  batchSize?: number;
  concurrency?: number;
  timeoutMs?: number;
  afterCreatedAt?: Date;
  allowLoopbackForTests?: boolean;
  transport?: CanonicalEventTransport;
  durable?: boolean;
  workerId?: string;
  leaseMs?: number;
  retryPolicy?: DeliveryRetryPolicy;
}

export type CanonicalEventTransport = (
  destination: CanonicalWebhookDestination,
  event: AnyExternalEvent,
  options?: CanonicalHttpTransportOptions,
) => Promise<CanonicalDeliveryResult>;

export interface CanonicalHttpTransportOptions {
  timeoutMs?: number;
  allowLoopbackForTests?: boolean;
  durable?: boolean;
  workerId?: string;
  leaseMs?: number;
  retryPolicy?: DeliveryRetryPolicy;
  /**
   * Test seam to inject a controlled resolver. Production always uses the
   * system resolver; the value is resolved exactly once per dispatch so the
   * TCP connection is pinned to the address that passed validation.
   */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

type ResolvedUrl = { url: URL; addresses: string[] };

const clampInteger = (value: number | undefined, fallback: number, max: number) =>
  Math.min(Math.max(Math.trunc(value ?? fallback), 1), max);

function isPrivateIp(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const ip = address.toLowerCase();
  return ip === "::" || ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb") || ip.startsWith("::ffff:127.") || ip.startsWith("::ffff:10.") || ip.startsWith("::ffff:192.168.");
}

async function resolveSafeUrl(rawUrl: string, allowLoopbackForTests: boolean, resolveHost?: (hostname: string) => Promise<string[]>): Promise<ResolvedUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Malformed destination URL.");
  }
  if (url.protocol !== "https:" && !(allowLoopbackForTests && url.protocol === "http:")) throw new Error("Unsupported destination URL scheme.");
  if (url.username || url.password) throw new Error("Destination URL credentials are not allowed.");

  const hostname = url.hostname;
  const literalIp = net.isIP(hostname) ? hostname : null;
  const resolve = resolveHost ?? (async (host: string) => (await dns.lookup(host, { all: true })).map((entry) => entry.address));
  const addresses = literalIp ? [literalIp] : await resolve(hostname);
  if (!addresses.length) throw new Error("Destination host did not resolve.");
  const unsafe = addresses.filter(isPrivateIp);
  if (unsafe.length && !allowLoopbackForTests) throw new Error("Unsafe destination network target.");
  if (unsafe.length && allowLoopbackForTests && !unsafe.every((address) => address === "127.0.0.1" || address === "::1")) throw new Error("Unsafe non-loopback test destination.");
  return { url, addresses };
}

async function postJson(resolved: ResolvedUrl, body: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; retryAfter: string | null }> {
  const address = resolved.addresses[0] as string;
  const family = net.isIPv6(address) ? 6 : 4;
  const client = resolved.url.protocol === "http:" ? http : https;

  return await new Promise((resolve, reject) => {
    const request = client.request(resolved.url, {
      method: "POST",
      headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
      servername: resolved.url.hostname,
      // Pin the connection to the address that passed SSRF validation. DNS is
      // resolved once (before connect); later changes (rebinding) cannot
      // redirect this socket, and `all` is honored for happy-eyeballs callers.
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions?.all) {
          callback(null, [{ address, family }]);
          return;
        }
        callback(null, address, family);
      },
    }, (response) => {
      const status = response.statusCode || 0;
      const retryAfter = response.headers["retry-after"]?.toString() ?? null;
      response.resume();
      response.on("end", () => resolve({ status, retryAfter }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.end(body);
  });
}

export async function validateCanonicalDestination(destination: CanonicalWebhookDestination, options: CanonicalHttpTransportOptions = {}): Promise<void> {
  if (!destination.id || !destination.tenantId || !destination.url) throw new Error("Destination id, tenantId and url are required.");
  await resolveSafeUrl(destination.url, options.allowLoopbackForTests === true, options.resolveHost);
}

export async function deliverCanonicalEventHttp(
  destination: CanonicalWebhookDestination,
  event: AnyExternalEvent,
  options: CanonicalHttpTransportOptions = {},
): Promise<CanonicalDeliveryResult> {
  const tenantId = event.tenantId;
  if (destination.tenantId !== tenantId) {
    return { status: "invalid_destination", eventId: event.id, destinationId: destination.id, tenantId, reason: "Destination tenant does not match event tenant." };
  }

  const timeoutMs = clampInteger(options.timeoutMs, DEFAULT_DELIVERY_TIMEOUT_MS, MAX_DELIVERY_TIMEOUT_MS);
  let resolved: ResolvedUrl;
  try {
    resolved = await resolveSafeUrl(destination.url, options.allowLoopbackForTests === true, options.resolveHost);
  } catch (error) {
    return { status: "invalid_destination", eventId: event.id, destinationId: destination.id, tenantId, reason: error instanceof Error ? error.message : "Invalid destination." };
  }

  try {
    const body = JSON.stringify(validateExternalEvent(event));
    const signatureHeaders = destination.signingSecret ? signWebhookBody(body, destination.signingSecret) : null;
    const response = await postJson(resolved, body, {
      "Content-Type": "application/json",
      "X-Canonical-Event-Id": event.id,
      "X-Canonical-Tenant-Id": tenantId,
      ...(signatureHeaders ? { "X-WBA-Timestamp": signatureHeaders.timestamp, "X-WBA-Signature": signatureHeaders.signature } : {}),
    }, timeoutMs);
    if (response.status >= 300 && response.status < 400) {
      return { status: "invalid_destination", eventId: event.id, destinationId: destination.id, tenantId, reason: "HTTP redirects are not followed." };
    }
    return { status: response.status >= 200 && response.status < 300 ? "accepted" : "rejected", eventId: event.id, destinationId: destination.id, tenantId, httpStatus: response.status, retryAfter: response.retryAfter };
  } catch (error) {
    if (error instanceof Error && error.message === "timeout") return { status: "timeout", eventId: event.id, destinationId: destination.id, tenantId, timeoutMs };
    return { status: "network_error", eventId: event.id, destinationId: destination.id, tenantId, error: error instanceof Error ? error.message : "Network error." };
  }
}

export function classifyCanonicalDeliveryResult(result: CanonicalDeliveryResult): { attemptResult: DeliveryAttemptResult; terminal: boolean; retryAfter?: string | null; errorSummary?: string | null } {
  if (result.status === "accepted") return { attemptResult: "ACCEPTED", terminal: false };
  if (result.status === "invalid_destination") return { attemptResult: "TERMINAL", terminal: true, errorSummary: result.reason };
  if (result.status === "timeout") return { attemptResult: "RETRYABLE", terminal: false, errorSummary: `timeout after ${result.timeoutMs}ms` };
  if (result.status === "network_error") return { attemptResult: "RETRYABLE", terminal: false, errorSummary: result.error };
  if (result.httpStatus === 408 || result.httpStatus === 429 || result.httpStatus >= 500) {
    return { attemptResult: "RETRYABLE", terminal: false, retryAfter: result.retryAfter, errorSummary: `HTTP ${result.httpStatus}` };
  }
  return { attemptResult: "TERMINAL", terminal: true, errorSummary: `HTTP ${result.httpStatus}` };
}

async function deliverDurableCanonicalEvent(
  db: CanonicalEventPrisma,
  destination: CanonicalWebhookDestination,
  record: CanonicalEventOutboxRecord,
  options: CanonicalDeliveryWorkerOptions,
): Promise<DurableCanonicalDeliveryResult | null> {
  const event = validateExternalEvent(record.payload);
  const maxAttempts = Math.max(1, options.retryPolicy?.maxAttempts ?? DEFAULT_DELIVERY_MAX_ATTEMPTS);
  await createDeliveryForEvent(db, { tenantId: options.tenantId, eventId: record.id, destinationId: destination.id, maxAttempts });
  const claimed = await claimDelivery(db, {
    tenantId: options.tenantId,
    eventId: record.id,
    destinationId: destination.id,
    workerId: options.workerId,
    leaseMs: options.leaseMs ?? Math.max(DEFAULT_DELIVERY_LEASE_MS, clampInteger(options.timeoutMs, DEFAULT_DELIVERY_TIMEOUT_MS, MAX_DELIVERY_TIMEOUT_MS) + 5_000),
  });
  if (!claimed) return null;

  const transport = options.transport ?? deliverCanonicalEventHttp;
  const result = await transport(destination, event, { timeoutMs: options.timeoutMs, allowLoopbackForTests: options.allowLoopbackForTests });
  const classification = classifyCanonicalDeliveryResult(result);
  let nextRetryAt: Date | null = null;
  let terminal = classification.terminal;

  if (classification.attemptResult === "RETRYABLE") {
    const retry = nextRetryDecision(claimed.delivery.attemptCount, classification.retryAfter, { ...options.retryPolicy, maxAttempts });
    terminal = retry.exhausted;
    nextRetryAt = retry.nextRetryAt;
  }

  const completed = await completeDeliveryAttempt(db, {
    deliveryId: claimed.delivery.id,
    tenantId: options.tenantId,
    leaseOwner: claimed.attempt.leaseOwner,
    attemptNumber: claimed.attempt.attemptNumber,
    result: terminal && classification.attemptResult === "RETRYABLE" ? "TERMINAL" : classification.attemptResult as Exclude<DeliveryAttemptResult, "INTERRUPTED">,
    httpStatus: "httpStatus" in result ? result.httpStatus : null,
    errorSummary: classification.errorSummary,
    nextRetryAt,
    terminal,
  });

  return { ...result, deliveryId: claimed.delivery.id, attemptNumber: claimed.attempt.attemptNumber, finalState: completed?.state as DurableCanonicalDeliveryResult["finalState"], nextRetryAt };
}

export async function runCanonicalDeliveryWorker(
  db: CanonicalEventPrisma,
  options: CanonicalDeliveryWorkerOptions,
): Promise<CanonicalDeliveryWorkerResult> {
  if (options.destination.tenantId !== options.tenantId) throw new Error("Destination tenant must match worker tenant.");
  const batchSize = clampInteger(options.batchSize, DEFAULT_DELIVERY_BATCH_SIZE, MAX_DELIVERY_BATCH_SIZE);
  const concurrency = clampInteger(options.concurrency, DEFAULT_DELIVERY_CONCURRENCY, MAX_DELIVERY_CONCURRENCY);
  const transport = options.transport ?? deliverCanonicalEventHttp;
  const records = await listCanonicalEvents(db, { tenantId: options.tenantId, limit: batchSize, afterCreatedAt: options.afterCreatedAt });
  const results: DurableCanonicalDeliveryResult[] = [];
  let next = 0;

  await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, async () => {
    while (next < records.length) {
      const record = records[next++] as CanonicalEventOutboxRecord;
      const result = options.durable
        ? await deliverDurableCanonicalEvent(db, options.destination, record, options)
        : await transport(options.destination, validateExternalEvent(record.payload), { timeoutMs: options.timeoutMs, allowLoopbackForTests: options.allowLoopbackForTests });
      if (result) results.push(result);
      await sleep(0);
    }
  }));

  return { tenantId: options.tenantId, destinationId: options.destination.id, requestedBatchSize: batchSize, scannedEvents: records.length, results };
}
