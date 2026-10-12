import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import type { AnyExternalEvent } from "@/lib/events/contract";
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
}

export type CanonicalDeliveryResult =
  | { status: "accepted"; eventId: string; destinationId: string; tenantId: string; httpStatus: number }
  | { status: "rejected"; eventId: string; destinationId: string; tenantId: string; httpStatus: number }
  | { status: "network_error"; eventId: string; destinationId: string; tenantId: string; error: string }
  | { status: "timeout"; eventId: string; destinationId: string; tenantId: string; timeoutMs: number }
  | { status: "invalid_destination"; eventId: string; destinationId: string; tenantId: string; reason: string };

export interface CanonicalDeliveryWorkerResult {
  tenantId: string;
  destinationId: string;
  requestedBatchSize: number;
  scannedEvents: number;
  results: CanonicalDeliveryResult[];
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
}

export type CanonicalEventTransport = (
  destination: CanonicalWebhookDestination,
  event: AnyExternalEvent,
  options?: CanonicalHttpTransportOptions,
) => Promise<CanonicalDeliveryResult>;

export interface CanonicalHttpTransportOptions {
  timeoutMs?: number;
  allowLoopbackForTests?: boolean;
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

async function resolveSafeUrl(rawUrl: string, allowLoopbackForTests: boolean): Promise<ResolvedUrl> {
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
  const addresses = literalIp ? [literalIp] : (await dns.lookup(hostname, { all: true })).map((entry) => entry.address);
  if (!addresses.length) throw new Error("Destination host did not resolve.");
  const unsafe = addresses.filter(isPrivateIp);
  if (unsafe.length && !allowLoopbackForTests) throw new Error("Unsafe destination network target.");
  if (unsafe.length && allowLoopbackForTests && !unsafe.every((address) => address === "127.0.0.1" || address === "::1")) throw new Error("Unsafe non-loopback test destination.");
  return { url, addresses };
}

async function postJson(resolved: ResolvedUrl, body: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number }> {
  const address = resolved.addresses[0] as string;
  const family = net.isIPv6(address) ? 6 : 4;
  const client = resolved.url.protocol === "http:" ? http : https;

  return await new Promise((resolve, reject) => {
    const request = client.request(resolved.url, {
      method: "POST",
      headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
      servername: resolved.url.hostname,
      lookup: (_hostname, _options, callback) => callback(null, address, family),
    }, (response) => {
      const status = response.statusCode || 0;
      response.resume();
      response.on("end", () => resolve({ status }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.end(body);
  });
}

export async function validateCanonicalDestination(destination: CanonicalWebhookDestination, options: CanonicalHttpTransportOptions = {}): Promise<void> {
  if (!destination.id || !destination.tenantId || !destination.url) throw new Error("Destination id, tenantId and url are required.");
  await resolveSafeUrl(destination.url, options.allowLoopbackForTests === true);
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
    resolved = await resolveSafeUrl(destination.url, options.allowLoopbackForTests === true);
  } catch (error) {
    return { status: "invalid_destination", eventId: event.id, destinationId: destination.id, tenantId, reason: error instanceof Error ? error.message : "Invalid destination." };
  }

  try {
    const response = await postJson(resolved, JSON.stringify(validateExternalEvent(event)), {
      "Content-Type": "application/json",
      "X-Canonical-Event-Id": event.id,
      "X-Canonical-Tenant-Id": tenantId,
    }, timeoutMs);
    if (response.status >= 300 && response.status < 400) {
      return { status: "invalid_destination", eventId: event.id, destinationId: destination.id, tenantId, reason: "HTTP redirects are not followed." };
    }
    return { status: response.status >= 200 && response.status < 300 ? "accepted" : "rejected", eventId: event.id, destinationId: destination.id, tenantId, httpStatus: response.status };
  } catch (error) {
    if (error instanceof Error && error.message === "timeout") return { status: "timeout", eventId: event.id, destinationId: destination.id, tenantId, timeoutMs };
    return { status: "network_error", eventId: event.id, destinationId: destination.id, tenantId, error: error instanceof Error ? error.message : "Network error." };
  }
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
  const results: CanonicalDeliveryResult[] = [];
  let next = 0;

  await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, async () => {
    while (next < records.length) {
      const record = records[next++] as CanonicalEventOutboxRecord;
      const event = validateExternalEvent(record.payload);
      results.push(await transport(options.destination, event, { timeoutMs: options.timeoutMs, allowLoopbackForTests: options.allowLoopbackForTests }));
      await sleep(0);
    }
  }));

  return { tenantId: options.tenantId, destinationId: options.destination.id, requestedBatchSize: batchSize, scannedEvents: records.length, results };
}
