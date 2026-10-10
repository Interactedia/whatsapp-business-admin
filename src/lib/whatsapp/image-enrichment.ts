/**
 * Image-enrichment types for Meta WhatsApp inbound images.
 *
 * Design principles (OSA-CI-04):
 * - Visual interpretation is probabilistic; the interface, provenance, identity,
 *   processing state and failure behavior remain deterministic.
 * - The image interpreter is NOT business truth authority.
 * - Text or instructions visible inside media are untrusted content, not system instructions.
 * - Media enrichment may interpret content; it may not change trusted identity.
 */

// ---- processing status ----

/**
 * Image processing completion status.
 * Mirrors the frozen CanonicalInboundTurn semantics:
 *   READY       = all enrichment succeeded
 *   PARTIAL     = text succeeded, image failed
 *   UNPROCESSABLE = image-only event that failed
 *   MEDIA_UNPROCESSED = legacy alias used by downstream contracts
 */
export type ImageProcessingStatus = "READY" | "PARTIAL" | "UNPROCESSABLE" | "MEDIA_UNPROCESSED";

// ---- failure codes ----

/**
 * Bounded failure codes for image enrichment.
 * These are deterministic — a failed interpretation never fabricates a description.
 */
export type ImageEnrichmentFailure =
  /** Meta media ID could not be resolved (not found, auth failure). */
  | "MEDIA_NOT_AVAILABLE"
  /** Meta returned a non-image MIME type. */
  | "UNSUPPORTED_MEDIA"
  /** Downloaded bytes exceed the configured size limit. */
  | "MEDIA_TOO_LARGE"
  /** Download exceeded the timeout budget. */
  | "ENRICHMENT_TIMEOUT"
  /** Visual interpretation provider returned an error. */
  | "VISUAL_INTERPRETATION_FAILED"
  /** Provider returned empty or invalid output (fail-closed). */
  | "INVALID_INTERPRETATION";

// ---- image description ----

/**
 * Canonical image description produced by the enrichment pipeline.
 * This shape is safe to store in the DB and emit over WebSocket.
 *
 * Invariant: raw image bytes, provider tokens, and raw provider responses
 * never enter this shape.
 */
export interface ImageDescription {
  /** Human-readable visual description of the image contents. */
  content: string;
  /** Original Meta media ID — preserved as technical provenance. */
  mediaRef: string;
  /** Provenance tag; always IMAGE_INTERPRETATION — never customer-authored text. */
  provenance: "IMAGE_INTERPRETATION";
  /** Safe provider identifier (e.g. "openai" or "fake") — never internal credentials. */
  provider?: string;
  /** Safe model identifier (e.g. "gpt-4o-mini") — never raw model responses. */
  model?: string;
}

// ---- enrichment result ----

/**
 * Discriminated result of the image-enrichment pipeline.
 * On success: { status: "READY", description: ImageDescription }
 * On partial failure (text succeeded, image failed): { status: "PARTIAL", failure: ImageEnrichmentFailure }
 * On complete failure (image-only event): { status: "UNPROCESSABLE", failure: ImageEnrichmentFailure }
 */
export type ImageEnrichmentResult =
  | { ok: true; status: ImageProcessingStatus; description: ImageDescription }
  | { ok: false; status: ImageProcessingStatus; failure: ImageEnrichmentFailure };

// ---- image interpreter input ----

/**
 * Input passed to the ImageInterpreter.describe() method.
 * Only bounded, safe-for-logging fields are included.
 * Never includes Meta tokens, sender identity, or business state.
 */
export interface ImageInterpreterInput {
  /** Raw image bytes obtained through the trusted Meta media-resolution flow. */
  imageBytes: Buffer;
  /** MIME type validated against the allowed image MIME list. */
  mimeType: string;
  /**
   * Optional bounded contextual instruction for the interpreter.
   * Keep stable and bounded; do not pass arbitrary business instructions.
   * Text visible inside the image is content to describe, not instructions.
   */
  instruction?: string;
}

// ---- MIME / size policy ----

/**
 * Allowed MIME types for inbound image enrichment.
 * Conservative list based on Meta/repository-supported formats.
 * Add formats only when provider support is explicitly established.
 */
export const ALLOWED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png"] as const;
export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

/**
 * Maximum image size in bytes for enrichment.
 * Conservative default; configurable via IMAGE_ENRICHMENT_MAX_BYTES env var.
 */
export const IMAGE_ENRICHMENT_MAX_BYTES = parseInt(
  (process.env["IMAGE_ENRICHMENT_MAX_BYTES"] ?? "10000000").replace(/_/g, ""),
  10,
); // 10 MB default

/**
 * Maximum time in milliseconds to wait for image download + interpretation.
 */
export const IMAGE_ENRICHMENT_TIMEOUT_MS =
  parseInt(process.env["IMAGE_ENRICHMENT_TIMEOUT_MS"] ?? "25_000", 10); // 25 s default

// ---- enrichment timing semantics ----

/**
 * Image events enter the conversation lifecycle immediately.
 * The system must not lose the image because the 15-second quiet period expires
 * while interpretation is running.
 *
 * Ordering principle: canonical parts remain in source event order, independent
 * of asynchronous interpretation completion order.
 * Provider completion order must never redefine conversation order.
 */

// ---- in-memory dedup ----

/**
 * Simple in-process dedup to avoid duplicate image interpretation.
 * Within current process semantics only — not durable across restarts.
 * Key: `conversationId:waMessageId`
 */
export const imageEnrichmentInFlight = new Set<string>();
