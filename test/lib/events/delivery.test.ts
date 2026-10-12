import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyExternalEvent } from "@/lib/events";
import {
  classifyCanonicalDeliveryResult,
  deliverCanonicalEventHttp,
  runCanonicalDeliveryWorker,
  type CanonicalWebhookDestination,
} from "@/lib/events/delivery";
import { nextRetryDecision, retryAfterDelayMs } from "@/lib/events/retry-policy";
import type { CanonicalEventOutboxRecord } from "@/lib/events/outbox";

const ISO = "2026-10-11T12:00:00.000Z";
const tenantId = "tenant_alpha";

function event(overrides: Partial<AnyExternalEvent> = {}): AnyExternalEvent {
  return {
    id: "evt:inbound.message.received:tenant_alpha:msg_1",
    type: "inbound.message.received",
    version: 1,
    tenantId,
    occurredAt: ISO,
    recordedAt: ISO,
    entities: [{ kind: "tenant", id: tenantId }],
    meta: { producer: "core" },
    payload: {
      conversationId: "conv_1",
      messageId: "msg_1",
      contactId: "contact_1",
      phoneNumberId: "phone_1",
      wabaAccountId: "waba_1",
      type: "TEXT",
      receivedAt: ISO,
      providerMessageId: "wamid.1",
      preview: "hola",
    },
    ...overrides,
  } as AnyExternalEvent;
}

function destination(url: string, tenant = tenantId): CanonicalWebhookDestination {
  return { id: "dest_1", tenantId: tenant, url };
}

function record(payload: AnyExternalEvent): CanonicalEventOutboxRecord {
  return {
    id: payload.id,
    tenantId: payload.tenantId,
    eventType: payload.type,
    contractVersion: payload.version,
    payload,
    payloadHash: "hash",
    occurredAt: new Date(payload.occurredAt),
    recordedAt: new Date(payload.recordedAt),
    createdAt: new Date(payload.recordedAt),
  };
}

async function withServer(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/hook`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("canonical event HTTP delivery", () => {
  it("POSTs the exact ExternalEvent envelope to a local receiver", async () => {
    const sent = event();
    let body = "";
    let headers: http.IncomingHttpHeaders = {};
    const server = await withServer((req, res) => {
      headers = req.headers;
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => { res.writeHead(202).end("accepted"); });
    });

    try {
      const result = await deliverCanonicalEventHttp(destination(server.url), sent, { allowLoopbackForTests: true });
      expect(result).toMatchObject({ status: "accepted", httpStatus: 202, eventId: sent.id, tenantId });
      expect(headers["content-type"]).toBe("application/json");
      expect(headers["x-canonical-event-id"]).toBe(sent.id);
      expect(JSON.parse(body)).toEqual(sent);
    } finally {
      await server.close();
    }
  });

  it.each([200, 202])("classifies HTTP %s as transport acceptance", async (status) => {
    const server = await withServer((_req, res) => res.writeHead(status).end());
    try {
      await expect(deliverCanonicalEventHttp(destination(server.url), event(), { allowLoopbackForTests: true })).resolves.toMatchObject({ status: "accepted", httpStatus: status });
    } finally {
      await server.close();
    }
  });

  it.each([400, 500])("classifies HTTP %s as rejection", async (status) => {
    const server = await withServer((_req, res) => res.writeHead(status).end());
    try {
      await expect(deliverCanonicalEventHttp(destination(server.url), event(), { allowLoopbackForTests: true })).resolves.toMatchObject({ status: "rejected", httpStatus: status });
    } finally {
      await server.close();
    }
  });

  it("classifies connection failure", async () => {
    const server = await withServer((_req, res) => res.writeHead(200).end());
    const url = server.url;
    await server.close();
    await expect(deliverCanonicalEventHttp(destination(url), event(), { allowLoopbackForTests: true })).resolves.toMatchObject({ status: "network_error" });
  });

  it("classifies timeout", async () => {
    const server = await withServer((_req, res) => setTimeout(() => res.writeHead(200).end(), 80));
    try {
      await expect(deliverCanonicalEventHttp(destination(server.url), event(), { timeoutMs: 10, allowLoopbackForTests: true })).resolves.toMatchObject({ status: "timeout", timeoutMs: 10 });
    } finally {
      await server.close();
    }
  });

  it("rejects tenant mismatch before network activity", async () => {
    let hit = false;
    const server = await withServer((_req, res) => { hit = true; res.writeHead(200).end(); });
    try {
      await expect(deliverCanonicalEventHttp(destination(server.url, "tenant_beta"), event(), { allowLoopbackForTests: true })).resolves.toMatchObject({ status: "invalid_destination" });
      expect(hit).toBe(false);
    } finally {
      await server.close();
    }
  });

  it.each(["not a url", "ftp://example.com/hook"])("rejects invalid destination %s", async (url) => {
    await expect(deliverCanonicalEventHttp(destination(url), event())).resolves.toMatchObject({ status: "invalid_destination" });
  });

  it("rejects unsafe private targets outside test mode", async () => {
    await expect(deliverCanonicalEventHttp(destination("http://127.0.0.1:1/hook"), event())).resolves.toMatchObject({ status: "invalid_destination" });
  });

  it("does not follow redirects", async () => {
    const target = await withServer((_req, res) => res.writeHead(200).end());
    const redirect = await withServer((_req, res) => res.writeHead(302, { Location: target.url }).end());
    try {
      await expect(deliverCanonicalEventHttp(destination(redirect.url), event(), { allowLoopbackForTests: true })).resolves.toMatchObject({ status: "invalid_destination" });
    } finally {
      await redirect.close();
      await target.close();
    }
  });

  it("classifies retryable and terminal results", () => {
    expect(classifyCanonicalDeliveryResult({ status: "accepted", eventId: "e", destinationId: "d", tenantId, httpStatus: 202 }).attemptResult).toBe("ACCEPTED");
    expect(classifyCanonicalDeliveryResult({ status: "rejected", eventId: "e", destinationId: "d", tenantId, httpStatus: 408 }).attemptResult).toBe("RETRYABLE");
    expect(classifyCanonicalDeliveryResult({ status: "rejected", eventId: "e", destinationId: "d", tenantId, httpStatus: 429 }).attemptResult).toBe("RETRYABLE");
    expect(classifyCanonicalDeliveryResult({ status: "rejected", eventId: "e", destinationId: "d", tenantId, httpStatus: 503 }).attemptResult).toBe("RETRYABLE");
    expect(classifyCanonicalDeliveryResult({ status: "rejected", eventId: "e", destinationId: "d", tenantId, httpStatus: 400 }).attemptResult).toBe("TERMINAL");
    expect(classifyCanonicalDeliveryResult({ status: "network_error", eventId: "e", destinationId: "d", tenantId, error: "ECONNRESET" }).attemptResult).toBe("RETRYABLE");
    expect(classifyCanonicalDeliveryResult({ status: "timeout", eventId: "e", destinationId: "d", tenantId, timeoutMs: 1 }).attemptResult).toBe("RETRYABLE");
  });

  it("bounds exponential backoff and Retry-After", () => {
    const now = new Date("2026-10-11T12:00:00.000Z");
    expect(retryAfterDelayMs("2", now, 10_000)).toBe(2_000);
    expect(retryAfterDelayMs("bad", now, 10_000)).toBeNull();
    expect(nextRetryDecision(2, null, { now, baseDelayMs: 1_000, maxDelayMs: 3_000, maxAttempts: 5 }).delayMs).toBe(2_000);
    expect(nextRetryDecision(5, null, { now, maxAttempts: 5 }).exhausted).toBe(true);
    expect(nextRetryDecision(1, "120", { now, maxDelayMs: 5_000, maxAttempts: 5 }).delayMs).toBe(5_000);
  });
});

describe("canonical delivery worker", () => {
  it("retrieves a bounded tenant batch and preserves outbox records", async () => {
    const payloads = [event({ id: "evt:inbound.message.received:tenant_alpha:msg_1" }), event({ id: "evt:inbound.message.received:tenant_alpha:msg_2" })];
    const records = payloads.map(record);
    const findMany = vi.fn(async (args) => records.slice(0, args.take));
    const db = { canonicalEventOutbox: { findMany } } as never;
    const transport = vi.fn(async (_dest, evt: AnyExternalEvent) => ({ status: "accepted" as const, eventId: evt.id, destinationId: "dest_1", tenantId: evt.tenantId, httpStatus: 200 }));

    const result = await runCanonicalDeliveryWorker(db, { tenantId, destination: destination("https://example.com/hook"), batchSize: 1, concurrency: 1, transport });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1, where: { tenantId } }));
    expect(result.scannedEvents).toBe(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(records[0]?.payload).toEqual(payloads[0]);
  });

  it("bounds concurrency", async () => {
    const records = Array.from({ length: 5 }, (_, i) => record(event({ id: `evt:inbound.message.received:tenant_alpha:msg_${i}` })));
    const db = { canonicalEventOutbox: { findMany: vi.fn(async () => records) } } as never;
    let active = 0;
    let maxActive = 0;
    const transport = vi.fn(async (_dest, evt: AnyExternalEvent) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { status: "accepted" as const, eventId: evt.id, destinationId: "dest_1", tenantId: evt.tenantId, httpStatus: 200 };
    });

    const result = await runCanonicalDeliveryWorker(db, { tenantId, destination: destination("https://example.com/hook"), batchSize: 5, concurrency: 2, transport });

    expect(result.results).toHaveLength(5);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("rejects worker destination tenant mismatch before retrieval", async () => {
    const findMany = vi.fn();
    const db = { canonicalEventOutbox: { findMany } } as never;
    await expect(runCanonicalDeliveryWorker(db, { tenantId, destination: destination("https://example.com/hook", "tenant_beta") })).rejects.toThrow("Destination tenant must match worker tenant");
    expect(findMany).not.toHaveBeenCalled();
  });
});
