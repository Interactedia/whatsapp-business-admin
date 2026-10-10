import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";

/**
 * External API keys for /api/v1. Keys are high-entropy random tokens; we store
 * only their SHA-256 hash plus a short prefix for identification in the UI.
 * The full key is shown to the user exactly once, at creation.
 */

const KEY_BYTES = 24; // 48 hex chars
const PREFIX = "wba_live_";

export type GeneratedKey = { plaintext: string; keyHash: string; keyPrefix: string };

function hashKey(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

/** Create a new key value (not yet persisted). */
export function generateKey(): GeneratedKey {
  const raw = crypto.randomBytes(KEY_BYTES).toString("hex");
  const plaintext = `${PREFIX}${raw}`;
  return {
    plaintext,
    keyHash: hashKey(plaintext),
    // Prefix stored for display, e.g. "wba_live_a1b2c3…"
    keyPrefix: `${plaintext.slice(0, PREFIX.length + 6)}…`,
  };
}

export type ApiKeyPrincipal = { apiKeyId: string; userId: string | null; tenantId: string | null };

/**
 * Look up a presented key. Returns the principal (key id + owning user + owning tenant) or null
 * if the key is unknown or revoked. Also records last-used (best effort).
 */
export async function verifyApiKey(plaintext: string | null | undefined): Promise<ApiKeyPrincipal | null> {
  if (!plaintext) return null;
  const keyHash = hashKey(plaintext);
  const key = await prisma.apiKey.findUnique({ where: { keyHash } });
  if (!key || key.revoked) return null;

  // Fire-and-forget last-used update.
  prisma.apiKey
    .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return { apiKeyId: key.id, userId: key.createdById, tenantId: key.tenantId };
}
