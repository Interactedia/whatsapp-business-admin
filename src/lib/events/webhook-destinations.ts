import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { encrypt, decrypt } from "@/lib/crypto";
import { EXTERNAL_EVENT_TYPES, type AnyExternalEvent, type ExternalEventType } from "@/lib/events/contract";
import { deliverCanonicalEventHttp, type CanonicalWebhookDestination, type CanonicalDeliveryResult } from "@/lib/events/delivery";
import { validateExternalEvent } from "@/lib/events/validation";
export { WEBHOOK_SIGNATURE_HEADER, WEBHOOK_SIGNATURE_VERSION, WEBHOOK_TIMESTAMP_HEADER, signWebhookBody, verifyWebhookSignature } from "@/lib/events/webhook-signing";
export const TEST_WEBHOOK_MIN_INTERVAL_MS = 60_000;

const EVENT_TYPES = Object.values(EXTERNAL_EVENT_TYPES) as [ExternalEventType, ...ExternalEventType[]];
const eventTypeSchema = z.enum(EVENT_TYPES);

function isUnsafeWebhookUrl(rawUrl: string): boolean {
  const url = new URL(rawUrl);
  const host = url.hostname.toLowerCase();
  return Boolean(url.username || url.password) || ["localhost", "127.0.0.1", "::1"].includes(host) || host.endsWith(".localhost");
}

export const webhookDestinationInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  endpointUrl: z.url()
    .refine((url) => new URL(url).protocol === "https:", "Only HTTPS webhook endpoints are supported.")
    .refine((url) => !isUnsafeWebhookUrl(url), "Webhook endpoint host is not allowed."),
  enabled: z.boolean().optional(),
  subscriptions: z.array(eventTypeSchema).min(1).max(EVENT_TYPES.length).refine((values) => new Set(values).size === values.length, "Duplicate subscriptions are not allowed."),
});

export type WebhookDestinationInput = z.infer<typeof webhookDestinationInputSchema>;

export type WebhookDestinationPublic = {
  id: string;
  tenantId: string;
  name: string;
  endpointUrl: string;
  enabled: boolean;
  retiredAt: string | null;
  subscriptions: ExternalEventType[];
  secretVersion: number;
  lastTestAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type DestinationRow = {
  id: string;
  tenantId: string;
  name: string;
  endpointUrl: string;
  enabled: boolean;
  retiredAt: Date | null;
  subscriptions: string[];
  signingSecretEnc: string;
  secretVersion: number;
  lastTestAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function toPublic(row: Omit<DestinationRow, "signingSecretEnc">): WebhookDestinationPublic {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    endpointUrl: row.endpointUrl,
    enabled: row.enabled,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    subscriptions: row.subscriptions as ExternalEventType[],
    secretVersion: row.secretVersion,
    lastTestAt: row.lastTestAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const publicSelect = {
  id: true,
  tenantId: true,
  name: true,
  endpointUrl: true,
  enabled: true,
  retiredAt: true,
  subscriptions: true,
  secretVersion: true,
  lastTestAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export function generateWebhookSigningSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export async function listWebhookDestinations(tenantId: string): Promise<WebhookDestinationPublic[]> {
  const rows = await prisma.webhookDestination.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    select: publicSelect,
  });
  return rows.map(toPublic);
}

export async function getWebhookDestination(tenantId: string, id: string): Promise<WebhookDestinationPublic | null> {
  const row = await prisma.webhookDestination.findFirst({ where: { tenantId, id }, select: publicSelect });
  return row ? toPublic(row) : null;
}

export async function createWebhookDestination(tenantId: string, input: WebhookDestinationInput) {
  const data = webhookDestinationInputSchema.parse(input);
  const secret = generateWebhookSigningSecret();
  const row = await prisma.webhookDestination.create({
    data: {
      tenantId,
      name: data.name,
      endpointUrl: data.endpointUrl,
      enabled: data.enabled ?? true,
      subscriptions: data.subscriptions,
      signingSecretEnc: encrypt(secret),
    },
    select: publicSelect,
  });
  return { destination: toPublic(row), signingSecret: secret };
}

export async function updateWebhookDestination(tenantId: string, id: string, input: Partial<WebhookDestinationInput>) {
  const current = await prisma.webhookDestination.findFirst({ where: { tenantId, id }, select: { id: true, retiredAt: true } });
  if (!current) return null;
  if (current.retiredAt) throw new Error("Retired destinations cannot be updated.");
  const data = webhookDestinationInputSchema.partial().parse(input);
  const row = await prisma.webhookDestination.update({
    where: { id },
    data,
    select: publicSelect,
  });
  return toPublic(row);
}

export async function setWebhookDestinationEnabled(tenantId: string, id: string, enabled: boolean) {
  const current = await prisma.webhookDestination.findFirst({ where: { tenantId, id }, select: { id: true, retiredAt: true } });
  if (!current) return null;
  if (current.retiredAt && enabled) throw new Error("Retired destinations cannot be enabled.");
  const row = await prisma.webhookDestination.update({ where: { id }, data: { enabled }, select: publicSelect });
  return toPublic(row);
}

export async function retireWebhookDestination(tenantId: string, id: string) {
  const current = await prisma.webhookDestination.findFirst({ where: { tenantId, id }, select: { id: true, retiredAt: true } });
  if (!current) return null;
  const row = await prisma.webhookDestination.update({
    where: { id },
    data: { enabled: false, retiredAt: current.retiredAt ?? new Date() },
    select: publicSelect,
  });
  return toPublic(row);
}

export async function rotateWebhookDestinationSecret(tenantId: string, id: string) {
  const current = await prisma.webhookDestination.findFirst({ where: { tenantId, id }, select: { id: true, retiredAt: true, secretVersion: true } });
  if (!current) return null;
  if (current.retiredAt) throw new Error("Retired destinations cannot rotate secrets.");
  const signingSecret = generateWebhookSigningSecret();
  const row = await prisma.webhookDestination.update({
    where: { id },
    data: { signingSecretEnc: encrypt(signingSecret), secretVersion: current.secretVersion + 1 },
    select: publicSelect,
  });
  return { destination: toPublic(row), signingSecret };
}

export async function destinationForDispatch(tenantId: string, id: string): Promise<CanonicalWebhookDestination | null> {
  const row = await prisma.webhookDestination.findFirst({
    where: { tenantId, id, enabled: true, retiredAt: null },
    select: { id: true, tenantId: true, endpointUrl: true, signingSecretEnc: true },
  });
  if (!row) return null;
  return { id: row.id, tenantId: row.tenantId, url: row.endpointUrl, signingSecret: decrypt(row.signingSecretEnc) };
}

export async function sendSyntheticWebhookTest(tenantId: string, id: string, now = new Date()): Promise<CanonicalDeliveryResult | { status: "rate_limited"; retryAfterMs: number } | null> {
  const row = await prisma.webhookDestination.findFirst({
    where: { tenantId, id, enabled: true, retiredAt: null },
    select: { id: true, tenantId: true, endpointUrl: true, signingSecretEnc: true, lastTestAt: true },
  });
  if (!row) return null;
  if (row.lastTestAt && now.getTime() - row.lastTestAt.getTime() < TEST_WEBHOOK_MIN_INTERVAL_MS) {
    return { status: "rate_limited", retryAfterMs: TEST_WEBHOOK_MIN_INTERVAL_MS - (now.getTime() - row.lastTestAt.getTime()) };
  }
  const event = validateExternalEvent({
    id: `evt:test:${tenantId}:${crypto.randomUUID()}`,
    type: EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED,
    version: 1,
    tenantId,
    occurredAt: now.toISOString(),
    recordedAt: now.toISOString(),
    entities: [{ kind: "tenant", id: tenantId }],
    meta: { producer: "webhook-destination-test" },
    payload: {
      conversationId: "synthetic-test",
      contactId: "synthetic-test-contact",
      phoneNumberId: null,
      wabaAccountId: null,
      kind: "CREATED",
      status: null,
      occurredAt: now.toISOString(),
    },
  } as AnyExternalEvent);
  const result = await deliverCanonicalEventHttp({ id: row.id, tenantId, url: row.endpointUrl, signingSecret: decrypt(row.signingSecretEnc) }, event, { timeoutMs: 5_000 });
  await prisma.webhookDestination.update({ where: { id }, data: { lastTestAt: now } });
  return result;
}

export async function listWebhookDeliveryHistory(tenantId: string, destinationId: string, limit = 50) {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const destination = await prisma.webhookDestination.findFirst({ where: { tenantId, id: destinationId }, select: { id: true } });
  if (!destination) return null;
  return prisma.canonicalEventDelivery.findMany({
    where: { tenantId, destinationId },
    orderBy: { createdAt: "desc" },
    take: safeLimit,
    select: {
      id: true,
      tenantId: true,
      eventId: true,
      destinationId: true,
      state: true,
      attemptCount: true,
      lastError: true,
      createdAt: true,
      updatedAt: true,
      event: { select: { eventType: true } },
      attempts: {
        orderBy: { attemptNumber: "desc" },
        take: 5,
        select: { attemptNumber: true, httpStatus: true, result: true, errorSummary: true, startedAt: true, completedAt: true, nextRetryAt: true },
      },
    },
  });
}
