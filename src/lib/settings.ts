import { prisma } from "@/lib/prisma";
import { decrypt, encrypt } from "@/lib/crypto";

export type WabaConfig = {
  wabaId: string | null;
  metaAppId: string | null;
  phoneNumberId: string | null;
  phoneNumberDisplay: string | null;
  businessName: string | null;
  accessToken: string | null; // decrypted
  appSecret: string | null;
  webhookVerifyToken: string | null;
  apiVersion: string;
};

const SETTINGS_ID = "default";

/** Load settings with the access token decrypted. Server-side only. */
export async function getWabaConfig(): Promise<WabaConfig> {
  const row = await prisma.wabaSettings.findUnique({ where: { id: SETTINGS_ID } });
  return {
    wabaId: row?.wabaId ?? null,
    metaAppId: row?.metaAppId ?? null,
    phoneNumberId: row?.phoneNumberId ?? null,
    phoneNumberDisplay: row?.phoneNumberDisplay ?? null,
    businessName: row?.businessName ?? null,
    accessToken: row?.accessTokenEnc ? decrypt(row.accessTokenEnc) : null,
    appSecret: row?.appSecret ?? null,
    webhookVerifyToken: row?.webhookVerifyToken ?? null,
    apiVersion: row?.apiVersion ?? process.env.GRAPH_API_VERSION ?? "v21.0",
  };
}

export type WabaUpdate = {
  wabaId?: string | null;
  metaAppId?: string | null;
  phoneNumberId?: string | null;
  phoneNumberDisplay?: string | null;
  businessName?: string | null;
  accessToken?: string | null; // plaintext in, encrypted at rest
  appSecret?: string | null;
  webhookVerifyToken?: string | null;
  apiVersion?: string;
};

export async function updateWabaConfig(update: WabaUpdate): Promise<void> {
  const data: Record<string, unknown> = {};
  if (update.wabaId !== undefined) data.wabaId = update.wabaId;
  if (update.metaAppId !== undefined) data.metaAppId = update.metaAppId;
  if (update.phoneNumberId !== undefined) data.phoneNumberId = update.phoneNumberId;
  if (update.phoneNumberDisplay !== undefined) data.phoneNumberDisplay = update.phoneNumberDisplay;
  if (update.businessName !== undefined) data.businessName = update.businessName;
  if (update.appSecret !== undefined) data.appSecret = update.appSecret;
  if (update.webhookVerifyToken !== undefined) data.webhookVerifyToken = update.webhookVerifyToken;
  if (update.apiVersion !== undefined) data.apiVersion = update.apiVersion;
  // Only re-encrypt when a non-empty token is provided (empty string = clear).
  if (update.accessToken !== undefined) {
    data.accessTokenEnc = update.accessToken ? encrypt(update.accessToken) : null;
  }

  await prisma.wabaSettings.upsert({
    where: { id: SETTINGS_ID },
    update: data,
    create: { id: SETTINGS_ID, ...data },
  });
}

export function isConfigured(cfg: WabaConfig): boolean {
  return Boolean(cfg.phoneNumberId && cfg.accessToken);
}

/**
 * Load tenant-scoped WABA settings with access token decrypted.
 * Returns null if tenant has no WABA configured.
 * Never falls back to the legacy singleton.
 */
export async function getTenantWabaConfig(tenantId: string): Promise<WabaConfig | null> {
  const waba = await prisma.wabaAccount.findFirst({
    where: { tenantId },
    include: { phoneNumbers: true },
  });
  if (!waba) return null;

  const phone = waba.phoneNumbers[0];
  return {
    wabaId: waba.metaWabaId,
    metaAppId: waba.metaAppId ?? null,
    phoneNumberId: phone?.metaPhoneNumberId ?? null,
    phoneNumberDisplay: phone?.displayPhone ?? null,
    businessName: phone?.verifiedName ?? waba.name ?? null,
    accessToken: waba.accessTokenEnc ? decrypt(waba.accessTokenEnc) : null,
    appSecret: waba.appSecret ?? null,
    webhookVerifyToken: waba.webhookVerifyToken ?? null,
    apiVersion: waba.apiVersion ?? process.env.GRAPH_API_VERSION ?? "v21.0",
  };
}

/**
 * Update tenant-scoped WABA settings.
 * Enforces tenant ownership and persists to WabaAccount and PhoneNumber models.
 */
export async function updateTenantWabaConfig(tenantId: string, update: WabaUpdate): Promise<void> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new Error("Tenant not found");

  let waba = await prisma.wabaAccount.findFirst({
    where: { tenantId },
    include: { phoneNumbers: true },
  });

  const wabaData: Record<string, unknown> = {};
  if (update.wabaId !== undefined && update.wabaId) wabaData.metaWabaId = update.wabaId;
  if (update.metaAppId !== undefined) wabaData.metaAppId = update.metaAppId;
  if (update.businessName !== undefined) wabaData.name = update.businessName;
  if (update.appSecret !== undefined) wabaData.appSecret = update.appSecret;
  if (update.webhookVerifyToken !== undefined) wabaData.webhookVerifyToken = update.webhookVerifyToken;
  if (update.apiVersion !== undefined) wabaData.apiVersion = update.apiVersion;
  if (update.accessToken !== undefined) {
    wabaData.accessTokenEnc = update.accessToken ? encrypt(update.accessToken) : null;
  }

  if (waba) {
    waba = await prisma.wabaAccount.update({
      where: { id: waba.id },
      data: wabaData,
      include: { phoneNumbers: true },
    });
  } else {
    const metaWabaId = update.wabaId || update.phoneNumberId || `waba_${tenantId}`;
    waba = await prisma.wabaAccount.create({
      data: {
        tenantId,
        metaWabaId,
        name: update.businessName ?? null,
        metaAppId: update.metaAppId ?? null,
        appSecret: update.appSecret ?? null,
        webhookVerifyToken: update.webhookVerifyToken ?? null,
        apiVersion: update.apiVersion ?? process.env.GRAPH_API_VERSION ?? "v21.0",
        accessTokenEnc: update.accessToken ? encrypt(update.accessToken) : null,
      },
      include: { phoneNumbers: true },
    });
  }

  // Handle primary phone number
  const phone = waba.phoneNumbers[0];
  const phoneData: Record<string, unknown> = {};
  if (update.phoneNumberId !== undefined && update.phoneNumberId) phoneData.metaPhoneNumberId = update.phoneNumberId;
  if (update.phoneNumberDisplay !== undefined) phoneData.displayPhone = update.phoneNumberDisplay;
  if (update.businessName !== undefined) phoneData.verifiedName = update.businessName;

  if (phone) {
    if (Object.keys(phoneData).length > 0) {
      await prisma.phoneNumber.update({
        where: { id: phone.id },
        data: phoneData,
      });
    }
  } else if (update.phoneNumberId) {
    await prisma.phoneNumber.create({
      data: {
        wabaAccountId: waba.id,
        metaPhoneNumberId: update.phoneNumberId,
        displayPhone: update.phoneNumberDisplay ?? null,
        verifiedName: update.businessName ?? null,
      },
    });
  }
}
