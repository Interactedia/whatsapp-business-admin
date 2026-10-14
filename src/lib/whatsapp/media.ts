import { prisma } from "@/lib/prisma";
import type { WabaConfig } from "@/lib/settings";
import { mediaStore, extFromMime } from "@/lib/media";
import { graphFetch, WhatsAppApiError } from "@/lib/whatsapp/client";

const GRAPH_HOST = "https://graph.facebook.com";

/**
 * Download an inbound media object by its Meta media ID and store it locally.
 * Returns the stored relative path + mime.
 */
export async function downloadInboundMedia(
  mediaId: string,
  config: WabaConfig,
): Promise<{ path: string; mime: string } | null> {
  const cfg = config;
  if (!cfg.accessToken) return null;

  // 1) Resolve the media ID to a temporary download URL (logged via graphFetch).
  const meta = await graphFetch<{ url: string; mime_type: string }>({
    method: "GET",
    path: `/${mediaId}`,
    related: { type: "media", id: mediaId },
    config: cfg,
  });
  if (!meta?.url) return null;

  // 2) Fetch the actual bytes (needs the Bearer token; not logged as body).
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${cfg.accessToken}` } });
  if (!res.ok) throw new WhatsAppApiError(res.status, "Failed to download media bytes");
  const buffer = Buffer.from(await res.arrayBuffer());
  const mime = meta.mime_type || res.headers.get("content-type") || "application/octet-stream";
  const stored = await mediaStore.save(buffer, extFromMime(mime));
  return { path: stored, mime };
}

const MAX_STORE_BYTES = 25 * 1024 * 1024; // 25 MB cap for local copies

/**
 * Best-effort: fetch a public media URL and store a local copy so outbound
 * media sent by link still renders in the inbox. Returns null on any failure
 * (the message is still sent to Meta regardless).
 */
export async function storeFromLink(link: string): Promise<{ path: string; mime: string } | null> {
  try {
    const res = await fetch(link);
    if (!res.ok) return null;
    const mime = res.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
    const len = Number(res.headers.get("content-length") || 0);
    if (len && len > MAX_STORE_BYTES) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_STORE_BYTES) return null;
    const path = await mediaStore.save(buffer, extFromMime(mime));
    return { path, mime };
  } catch {
    return null;
  }
}

/**
 * Upload an outbound media file to Meta and return its media ID for sending.
 */
export async function uploadOutboundMedia(opts: {
  data: Buffer;
  mimeType: string;
  fileName: string;
  config: WabaConfig;
}): Promise<string> {
  const cfg = opts.config;
  if (!cfg.accessToken || !cfg.phoneNumberId) {
    throw new WhatsAppApiError(400, "WhatsApp is not connected.");
  }
  const version = cfg.apiVersion || "v21.0";

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", opts.mimeType);
  form.append("file", new Blob([new Uint8Array(opts.data)], { type: opts.mimeType }), opts.fileName);

  const started = Date.now();
  const res = await fetch(`${GRAPH_HOST}/${version}/${cfg.phoneNumberId}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.accessToken}` },
    body: form,
  });
  const body = await res.json().catch(() => ({}));

  await prisma.apiLog
    .create({
      data: {
        method: "POST",
        endpoint: `/${version}/${cfg.phoneNumberId}/media`,
        responseStatus: res.status,
        responseBody: body as object,
        ok: res.ok,
        durationMs: Date.now() - started,
        relatedType: "media-upload",
      },
    })
    .catch((e) => console.error("ApiLog write failed:", e));

  if (!res.ok || !body.id) {
    throw new WhatsAppApiError(res.status, body?.error?.message || "Media upload failed");
  }
  return body.id as string;
}
