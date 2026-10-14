import { prisma } from "@/lib/prisma";
import type { WabaConfig } from "@/lib/settings";
import { WhatsAppApiError } from "@/lib/whatsapp/client";

const GRAPH_HOST = "https://graph.facebook.com";

async function log(method: string, endpoint: string, status: number | null, response: unknown, ok: boolean, started: number) {
  await prisma.apiLog
    .create({
      data: {
        method,
        endpoint,
        responseStatus: status ?? undefined,
        responseBody: (response ?? undefined) as object | undefined,
        ok,
        durationMs: Date.now() - started,
        relatedType: "template-upload",
      },
    })
    .catch((e) => console.error("ApiLog write failed:", e));
}

/**
 * Upload a media sample for a template header via Meta's Resumable Upload API and
 * return the resulting header handle to embed in the template's example.
 * Requires the Meta App ID to be configured.
 */
export async function uploadTemplateMediaSample(opts: {
  data: Buffer;
  mimeType: string;
  fileName: string;
  config: WabaConfig;
}): Promise<string> {
  const config = opts.config;
  if (!config.accessToken) throw new WhatsAppApiError(400, "WhatsApp is not connected.");
  if (!config.metaAppId) {
    throw new WhatsAppApiError(400, "Set your Meta App ID in Settings to use media-header templates.");
  }
  const version = config.apiVersion || "v21.0";

  // 1) Create an upload session.
  let started = Date.now();
  const createUrl =
    `${GRAPH_HOST}/${version}/${config.metaAppId}/uploads?` +
    new URLSearchParams({
      file_name: opts.fileName,
      file_length: String(opts.data.length),
      file_type: opts.mimeType,
      access_token: config.accessToken,
    });
  const createRes = await fetch(createUrl, { method: "POST" });
  const createBody = await createRes.json().catch(() => ({}));
  await log("POST", `/${version}/${config.metaAppId}/uploads`, createRes.status, createBody, createRes.ok, started);
  if (!createRes.ok || !createBody.id) {
    throw new WhatsAppApiError(createRes.status, createBody?.error?.message || "Failed to start upload");
  }
  const sessionId: string = createBody.id;

  // 2) Upload the bytes.
  started = Date.now();
  const uploadRes = await fetch(`${GRAPH_HOST}/${version}/${sessionId}`, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${config.accessToken}`,
      file_offset: "0",
    },
    body: new Uint8Array(opts.data),
  });
  const uploadBody = await uploadRes.json().catch(() => ({}));
  await log("POST", `/${version}/${sessionId}`, uploadRes.status, uploadBody, uploadRes.ok, started);
  if (!uploadRes.ok || !uploadBody.h) {
    throw new WhatsAppApiError(uploadRes.status, uploadBody?.error?.message || "Failed to upload media sample");
  }
  return uploadBody.h as string;
}
