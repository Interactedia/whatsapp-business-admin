import { prisma } from "@/lib/prisma";
import { getWabaConfig, type WabaConfig } from "@/lib/settings";
import { boundedPayload, payloadExpiresAt, safeHeaders } from "@/lib/diagnostics/payload";

function graphHost() {
  return process.env.GRAPH_API_BASE_URL || "https://graph.facebook.com";
}

export class WhatsAppApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: number,
    public details?: unknown,
    public userMessage?: string,
    public userTitle?: string,
    public subcode?: number,
  ) {
    super(message);
    this.name = "WhatsAppApiError";
  }
}

export type GraphRequest = {
  method: "GET" | "POST" | "DELETE";
  /** Path after the API version, e.g. "/{phoneNumberId}/messages" or "/{wabaId}/message_templates". */
  path: string;
  body?: unknown | FormData;
  query?: Record<string, string | number | undefined>;
  /** For linking the ApiLog row to a domain object. */
  related?: { type: string; id?: string };
  /** Provide a config to avoid a second DB read; otherwise loaded automatically. */
  config?: WabaConfig;
  /** Optional AbortSignal for request-level cancellation/timeout. */
  signal?: AbortSignal;
  diagnostics?: {
    tenantId?: string | null;
    wabaId?: string | null;
    phoneNumberId?: string | null;
    attemptId?: string | null;
    jobId?: string | null;
    attemptNumber?: number | null;
  };
};

/**
 * Central Graph API caller. EVERY outbound WhatsApp Cloud API request goes
 * through here so it is automatically persisted to ApiLog (request + response).
 * The access token is never written to the log.
 */
export async function graphFetch<T = unknown>(req: GraphRequest): Promise<T> {
  const config = req.config ?? (await getWabaConfig());
  if (!config.accessToken) {
    throw new WhatsAppApiError(400, "WhatsApp is not connected. Set your access token in Settings.");
  }

  const version = config.apiVersion || "v21.0";
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const query = qs.toString();
  const endpoint = `/${version}${req.path}${query ? `?${query}` : ""}`;
  const url = `${graphHost()}${endpoint}`;

  const started = Date.now();
  let responseStatus: number | null = null;
  let responseBody: unknown = null;
  let responseHeaders: Record<string, string> | undefined;
  let ok = false;
  let error: string | undefined;

  try {
    const multipart = req.body instanceof FormData;
    const res = await fetch(url, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        ...(req.body && !multipart ? { "Content-Type": "application/json" } : {}),
      },
      body: req.body ? (multipart ? (req.body as FormData) : JSON.stringify(req.body)) : undefined,
      signal: req.signal,
    });
    responseStatus = res.status;
    responseHeaders = safeHeaders(res.headers);
    const text = await res.text();
    responseBody = text ? safeJson(text) : null;
    ok = res.ok;

    if (!res.ok) {
      const err = (responseBody as {
        error?: {
          message?: string;
          code?: number;
          error_data?: unknown;
          error_user_msg?: string;
          error_user_title?: string;
          error_subcode?: number;
        };
      })?.error;
      error = err?.message || `Graph API error (${res.status})`;
      throw new WhatsAppApiError(
        res.status,
        error,
        err?.code,
        err?.error_data,
        err?.error_user_msg,
        err?.error_user_title,
        err?.error_subcode,
      );
    }
    return responseBody as T;
  } catch (e) {
    error = error ?? (e instanceof Error ? e.message : String(e));
    if (responseStatus === null) {
      // Network-level failure — record it too.
      responseBody = { error };
    }
    throw e;
  } finally {
    const request = boundedPayload(sanitizeBody(req.body));
    const response = boundedPayload(responseBody);
    await prisma.apiLog
      .create({
        data: {
          tenantId: req.diagnostics?.tenantId ?? undefined,
          method: req.method,
          endpoint,
          requestHeaders: safeHeaders({ "content-type": req.body && !(req.body instanceof FormData) ? "application/json" : undefined }),
          requestBody: request.value as object | undefined,
          responseStatus: responseStatus ?? undefined,
          responseHeaders,
          responseBody: response.value as object | undefined,
          ok,
          durationMs: Date.now() - started,
          relatedType: req.related?.type,
          relatedId: req.related?.id,
          wabaId: req.diagnostics?.wabaId ?? config.wabaId ?? undefined,
          phoneNumberId: req.diagnostics?.phoneNumberId ?? config.phoneNumberId ?? undefined,
          attemptId: req.diagnostics?.attemptId ?? undefined,
          jobId: req.diagnostics?.jobId ?? undefined,
          attemptNumber: req.diagnostics?.attemptNumber ?? undefined,
          error,
          requestTruncated: request.truncated,
          responseTruncated: response.truncated,
          payloadExpiresAt: payloadExpiresAt(),
        },
      })
      .catch((logErr) => console.error("Failed to write ApiLog:", logErr));
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function sanitizeBody(body: unknown): object | undefined {
  if (body === undefined || body === null) return undefined;
  if (body instanceof FormData) {
    return { multipart: true, fields: Array.from(body.keys()).filter((key) => !/token|secret|password|key|file/i.test(key)) };
  }
  if (typeof body === "object") return body as object;
  return { value: String(body) };
}
