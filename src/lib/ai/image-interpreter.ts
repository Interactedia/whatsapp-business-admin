/**
 * Provider-independent ImageInterpreter interface.
 *
 * Design principles (OSA-CI-04):
 * - Visual interpretation is probabilistic; the interface, identity,
 *   and failure behavior remain deterministic.
 * - The interpreter is NOT business truth authority.
 * - Do not pass Meta tokens, sender identity, Frappe objects, or business state.
 * - Provider response must be validated before success; never return raw provider response.
 */

import type { ImageInterpreterInput } from "@/lib/whatsapp/image-enrichment";

/**
 * Discriminated result from the image interpreter.
 * Never exposes raw provider responses or internal credentials.
 */
export type ImageInterpreterResult =
  | {
      ok: true;
      /** Safe provider identifier, never an API key or internal name. */
      provider: string;
      /** Safe model identifier, never a raw API response. */
      model: string;
      /** Bounded factual description of the image contents. */
      description: string;
    }
  | {
      ok: false;
      /** Deterministic failure code. */
      reason: string;
    };

/**
 * Provider-independent image visual-interpretation interface.
 *
 * Conceptually equivalent to:
 *   ImageInterpreter.describe(input) → result
 *
 * Implementations must:
 * - Validate provider output before returning success (fail-closed on invalid/empty).
 * - Never expose raw provider responses or credentials.
 * - Return bounded, factual visual descriptions suitable for conversational context.
 * - Honour the input.instruction only as stable bounded guidance.
 */
export interface ImageInterpreter {
  /**
   * Produce a visual description of the given image.
   *
   * @param input - bounded image bytes + MIME + optional instruction
   * @param signal - optional AbortSignal for timeout
   */
  describe(input: ImageInterpreterInput, signal?: AbortSignal): Promise<ImageInterpreterResult>;

  /**
   * Human-readable name of this provider (e.g. "openai", "anthropic", "fake").
   * Used only in safe observability output — never credentials.
   */
  readonly providerName: string;

  /**
   * Human-readable model identifier (e.g. "gpt-4o-mini", "claude-3-haiku", "fake").
   * Used only in safe observability output — never raw API responses.
   */
  readonly modelName: string;
}

// ---- fake interpreter (for testing / when no real provider is configured) ----

/**
 * Fake interpreter for unit tests and local development.
 * Returns a stable canned description without calling any AI provider.
 *
 * Security note: this implementation never touches external services or credentials.
 */
export class FakeImageInterpreter implements ImageInterpreter {
  readonly providerName = "fake";
  readonly modelName = "fake-v1";

  private _description: string;
  private _shouldFail: boolean;
  private _failReason: string;

  constructor(opts?: { description?: string; shouldFail?: boolean; failReason?: string }) {
    this._description = opts?.description ?? "Imagen de prueba.";
    this._shouldFail = opts?.shouldFail ?? false;
    this._failReason = opts?.failReason ?? "FakeImageInterpreter: simulated failure";
  }

  async describe(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _input: ImageInterpreterInput,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _signal?: AbortSignal,
  ): Promise<ImageInterpreterResult> {
    if (this._shouldFail) {
      return { ok: false, reason: this._failReason };
    }
    if (!this._description.trim()) {
      return { ok: false, reason: "Empty description returned by interpreter" };
    }
    return {
      ok: true,
      provider: this.providerName,
      model: this.modelName,
      description: this._description,
    };
  }

  /** Factory for a configured fake that returns the given description. */
  static withDescription(desc: string) {
    return new FakeImageInterpreter({ description: desc });
  }

  /** Factory for a configured fake that always fails. */
  static failing(reason = "FakeImageInterpreter: simulated failure") {
    return new FakeImageInterpreter({ shouldFail: true, failReason: reason });
  }
}

// ---- OpenAI vision interpreter (activate when OPENAI_API_KEY is set) ----

export class OpenAIImageInterpreter implements ImageInterpreter {
  readonly providerName = "openai";
  readonly modelName: string;

  private readonly _apiKey: string;
  private readonly _timeoutMs: number;

  constructor(opts?: { apiKey?: string; model?: string; timeoutMs?: number }) {
    this._apiKey = opts?.apiKey ?? process.env["OPENAI_API_KEY"] ?? "";
    this._timeoutMs = opts?.timeoutMs ?? 20_000;
    this.modelName = opts?.model ?? process.env["OPENAI_VISION_MODEL"] ?? "gpt-4o-mini";
  }

  get available(): boolean {
    return Boolean(this._apiKey);
  }

  async describe(input: ImageInterpreterInput, signal?: AbortSignal): Promise<ImageInterpreterResult> {
    if (!this.available) {
      return { ok: false, reason: "OPENAI_API_KEY not configured" };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this._timeoutMs);
    const effectiveSignal = signal ?? controller.signal;

    try {
      const base64 = input.imageBytes.toString("base64");

      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this._apiKey}`,
        },
        body: JSON.stringify({
          model: this.modelName,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: `data:${input.mimeType};base64,${base64}`, detail: "low" },
                },
                {
                  type: "text",
                  text:
                    input.instruction ??
                    [
                      "Describe what you see in this image.",
                      "Mention any visible text if it is clearly legible.",
                      "Avoid unsupported measurements, speculation, or business conclusions.",
                      "Avoid qualification decisions.",
                      "Be factual and concise.",
                    ].join(" "),
                },
              ],
            },
          ],
          max_tokens: 300,
        }),
        signal: effectiveSignal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return { ok: false, reason: `OpenAI API error: ${response.status}` };
      }

      const data = await response.json() as {
        choices?: { message?: { content?: string } }[];
        error?: { message?: string };
      };

      if (data.error) {
        return { ok: false, reason: `OpenAI error: ${data.error.message}` };
      }

      const content = data.choices?.[0]?.message?.content?.trim();

      if (!content) {
        return { ok: false, reason: "Empty response from OpenAI" };
      }

      // Fail-closed: reject very short or suspiciously non-descriptive responses.
      if (content.length < 4) {
        return { ok: false, reason: "Response too short to be a valid description" };
      }

      return { ok: true, provider: this.providerName, model: this.modelName, description: content };
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === "AbortError") {
        return { ok: false, reason: "Interpretation timeout" };
      }
      return { ok: false, reason: `Unexpected error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}

// ---- interpreter factory ----

/**
 * Returns the best available ImageInterpreter based on runtime configuration.
 * Priority: OpenAI (if OPENAI_API_KEY is set) > Fake.
 *
 * This factory is used by the enrichment service. Tests can inject a FakeImageInterpreter
 * directly to control outcomes deterministically.
 */
export function createImageInterpreter(): ImageInterpreter {
  const openai = new OpenAIImageInterpreter();
  if (openai.available) return openai;
  return new FakeImageInterpreter({ description: "Imagen recibida." });
}
