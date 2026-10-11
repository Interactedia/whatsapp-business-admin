/**
 * Configuration for the WhatsApp typing-indicator service.
 *
 * Defaults are conservative: in-process per-phone-number serialization via p-queue
 * ensures only one ephemeral request fires at a time per phone number, preventing
 * uncontrolled Meta API traffic without introducing a distributed rate-limit
 * infrastructure.
 *
 * Limitations under multiple instances:
 *   - Each Node.js process maintains its own p-queue instance.
 *   - If two instances of the application run simultaneously (e.g. two Next.js
 *     workers), each will independently serialize typing requests for its own
 *     phone numbers.
 *   - For single-tenant deployments this is sufficient.  Multi-tenant,
 *     multi-instance deployments that need a shared limit should evaluate a
 *     Redis-backed approach after ADR-0005 (BullMQ/Redis) is accepted and only
 *     then as a separate implementation unit.
 */

/** Timeout for the Meta typing-indicator HTTP request in milliseconds. */
export const TYPING_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Minimum interval between two typing-indicator requests for the same phone number.
 * Prevents a caller from flooding Meta with back-to-back requests.
 * Value chosen to allow a natural typing pause while staying well within Meta's
 * implicit rate expectations for the `/messages` endpoint.
 */
export const TYPING_MIN_INTERVAL_MS = 5_000;

/**
 * Flag that globally enables or disables the typing-indicator capability.
 *
 * Set to `false` to disable without removing the service code.
 * Activate via an environment variable or runtime flag.
 */
export const TYPING_ENABLED = process.env["WHATSAPP_TYPING_ENABLED"] === "true";
