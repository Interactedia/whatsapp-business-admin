/**
 * Image-enrichment orchestration service.
 *
 * Pipeline: Meta media ID → trusted download → MIME/size validation → ImageInterpreter → ImageDescription
 *
 * Design principles (OSA-CI-04):
 * - Media resolution may only fetch URLs obtained through the authenticated Meta media-resolution flow.
 * - Do not expose an arbitrary URL downloader.
 * - Bounded image-size limits enforced.
 * - Interpretation timeout is bounded; never blocks indefinitely.
 * - Duplicate events do not duplicate image interpretation (in-process dedup).
 * - Failed interpretation never fabricates a description.
 * - Canonical ordering uses event order, not provider completion timing.
 *
 * Observable (safe): event_id, MIME, byte count, provider/model identifier,
 * resolution duration, interpretation duration, success/failure category.
 * Never log: raw image bytes, access tokens, Authorization headers, signed URLs.
 */

import type {
  ImageEnrichmentResult,
  ImageDescription,
  ImageProcessingStatus,
  ImageEnrichmentFailure,
} from "@/lib/whatsapp/image-enrichment";
import {
  ALLOWED_IMAGE_MIME_TYPES,
  IMAGE_ENRICHMENT_MAX_BYTES,
  IMAGE_ENRICHMENT_TIMEOUT_MS,
  imageEnrichmentInFlight,
} from "@/lib/whatsapp/image-enrichment";
import type { ImageInterpreter } from "@/lib/ai/image-interpreter";

/**
 * Injectable download function for testing.
 * Defaults to the real downloadAndValidateImage.
 */
type DownloadFn = (
  mediaId: string,
  config: { accessToken: string; apiVersion?: string },
  timeoutMs: number,
) => Promise<{ bytes: Buffer; mime: string } | { failure: ImageEnrichmentFailure }>;

/**
 * Input for the enrichment pipeline.
 */
export interface ImageEnrichmentInput {
  /** Original Meta media ID. */
  mediaId: string;
  /** Optional conversation + message ID for in-process dedup key. */
  dedupKey?: string;
  /** Optional instruction passed to the interpreter. */
  instruction?: string;
}

/**
 * Download and validate image bytes from Meta.
 * Returns null if download fails, times out, or MIME/size policy is violated.
 *
 * Security note: this only fetches URLs obtained through the authenticated Meta
 * media-resolution flow — never arbitrary URLs.
 */
export async function downloadAndValidateImage(
  mediaId: string,
  config: { accessToken: string; apiVersion?: string },
  timeoutMs = IMAGE_ENRICHMENT_TIMEOUT_MS,
): Promise<{ bytes: Buffer; mime: string } | { failure: ImageEnrichmentFailure }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // 1) Resolve media ID to download URL through trusted Meta API.
    const metaRes = await fetch(
      `https://graph.facebook.com/${config.apiVersion ?? "v21.0"}/${mediaId}`,
      {
        headers: { Authorization: `Bearer ${config.accessToken}` },
        signal: controller.signal,
      },
    );

    if (!metaRes.ok) {
      clearTimeout(timeout);
      return { failure: "MEDIA_NOT_AVAILABLE" };
    }

    const meta = await metaRes.json() as { url?: string; mime_type?: string };

    if (!meta?.url) {
      clearTimeout(timeout);
      return { failure: "MEDIA_NOT_AVAILABLE" };
    }

    // 2) Download the actual bytes using the signed URL.
    const bytesRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${config.accessToken}` },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!bytesRes.ok) {
      return { failure: "MEDIA_NOT_AVAILABLE" };
    }

    const bytes = Buffer.from(await bytesRes.arrayBuffer());
    const mime = meta.mime_type ?? bytesRes.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";

    // 3) Validate MIME type.
    const allowedMimes = ALLOWED_IMAGE_MIME_TYPES as unknown as string[];
    if (!allowedMimes.includes(mime)) {
      return { failure: "UNSUPPORTED_MEDIA" };
    }

    // 4) Validate size.
    if (bytes.length > IMAGE_ENRICHMENT_MAX_BYTES) {
      return { failure: "MEDIA_TOO_LARGE" };
    }

    return { bytes, mime };
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      return { failure: "ENRICHMENT_TIMEOUT" };
    }
    return { failure: "ENRICHMENT_TIMEOUT" };
  }
}

/**
 * Full image-enrichment pipeline.
 *
 * Steps:
 * 1. Dedup check (in-process).
 * 2. Download + validate from trusted Meta media API.
 * 3. Call ImageInterpreter.describe().
 * 4. Return canonical ImageEnrichmentResult.
 *
 * @param input - enrichment input
 * @param interpreter - ImageInterpreter instance (inject FakeImageInterpreter for tests)
 * @param downloadConfig - Meta API config { accessToken, apiVersion? }
 * @param download - optional injectable download fn for testing (defaults to downloadAndValidateImage)
 */
export async function enrichImage(
  input: ImageEnrichmentInput,
  interpreter: ImageInterpreter,
  downloadConfig: { accessToken: string; apiVersion?: string },
  download?: DownloadFn,
): Promise<ImageEnrichmentResult> {
  const dedupKey = input.dedupKey ?? input.mediaId;

  // 1) In-process dedup.
  if (imageEnrichmentInFlight.has(dedupKey)) {
    // Already processing this exact event — return a safe failure to avoid double work.
    return { ok: false, status: "PARTIAL", failure: "VISUAL_INTERPRETATION_FAILED" };
  }
  imageEnrichmentInFlight.add(dedupKey);

  const downloadFn = download ?? downloadAndValidateImage;

  try {
    const start = Date.now();

    // 2) Download and validate.
    const dl = await downloadFn(input.mediaId, downloadConfig, IMAGE_ENRICHMENT_TIMEOUT_MS);
    if (!("bytes" in dl)) {
      return { ok: false, status: "UNPROCESSABLE", failure: dl.failure };
    }

    const { bytes, mime } = dl;
    const downloadMs = Date.now() - start;

    // 3) Interpret with bounded timeout.
    const interpretTimeoutMs = Math.max(3_000, IMAGE_ENRICHMENT_TIMEOUT_MS - downloadMs);

    let interpResult: Awaited<ReturnType<ImageInterpreter["describe"]>>;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), interpretTimeoutMs);
      interpResult = await interpreter.describe(
        { imageBytes: bytes, mimeType: mime, instruction: input.instruction },
        controller.signal,
      );
      clearTimeout(timeout);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { ok: false, status: "UNPROCESSABLE", failure: "ENRICHMENT_TIMEOUT" };
      }
      return { ok: false, status: "UNPROCESSABLE", failure: "VISUAL_INTERPRETATION_FAILED" };
    }

    // 4) Validate and map result.
    if (!interpResult.ok) {
      return { ok: false, status: "UNPROCESSABLE", failure: "VISUAL_INTERPRETATION_FAILED" };
    }

    // Fail-closed: empty or too-short descriptions are invalid.
    if (!interpResult.description.trim() || interpResult.description.trim().length < 4) {
      return { ok: false, status: "UNPROCESSABLE", failure: "INVALID_INTERPRETATION" };
    }

    const description: ImageDescription = {
      content: interpResult.description.trim(),
      mediaRef: input.mediaId,
      provenance: "IMAGE_INTERPRETATION",
      provider: interpResult.provider,
      model: interpResult.model,
    };

    return { ok: true, status: "READY", description };
  } finally {
    imageEnrichmentInFlight.delete(dedupKey);
  }
}

/**
 * Map an enrichment result to a Prisma-storable failure string.
 */
export function enrichmentFailureToString(failure: ImageEnrichmentFailure): string {
  return failure;
}

/**
 * Map an enrichment result to the canonical image-processing status.
 * Used when composing with text events (PARTIAL vs READY).
 */
export function imageStatusFromEnrichment(result: ImageEnrichmentResult): ImageProcessingStatus {
  return result.status;
}
