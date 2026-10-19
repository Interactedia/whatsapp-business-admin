/**
 * Configuration for the WhatsApp typing-indicator service.
 *
 * Rate control (WA-TYPING-01 simplified): a single atomic Redis cooldown per
 * (tenant, sender phone number, recipient) admits at most one typing request
 * per window; everything else is discarded before being enqueued. The
 * per-phone p-queue only serialises the requests that passed the cooldown —
 * it never schedules future work.
 */

/** Timeout for the Meta typing-indicator HTTP request in milliseconds. */
export const TYPING_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Cooldown window between two typing-indicator requests for the same
 * (tenant, sender phone number, recipient) triple. Matches Meta's typing
 * indicator lifetime (~25s): while an indicator is on screen, further pings
 * add nothing. Enforced atomically in Redis (see ./cooldown.ts).
 */
export const TYPING_COOLDOWN_MS = 25_000;

/**
 * Flag that globally enables or disables the typing-indicator capability.
 *
 * Set to `false` to disable without removing the service code.
 * Activate via an environment variable or runtime flag.
 */
export const TYPING_ENABLED = process.env["WHATSAPP_TYPING_ENABLED"] === "true";
