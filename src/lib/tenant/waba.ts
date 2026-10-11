import { decrypt } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { assertTrustedTenantContext, TenantAuthorizationError, type TenantContext } from "@/lib/tenant";
import type { WabaConfig } from "@/lib/settings";

export type OwnedPhoneNumber = {
  id: string;
  metaPhoneNumberId: string;
  displayPhone: string | null;
  verifiedName: string | null;
  wabaAccount: {
    id: string;
    tenantId: string;
    metaWabaId: string;
    name: string | null;
    metaAppId?: string | null;
    accessTokenEnc?: string | null;
    appSecret?: string | null;
    apiVersion?: string | null;
  };
};

function assertOwner(context: TenantContext, phone: OwnedPhoneNumber | null): OwnedPhoneNumber {
  assertTrustedTenantContext(context);
  if (!phone || phone.wabaAccount.tenantId !== context.tenantId) throw new TenantAuthorizationError();
  return phone;
}

export async function resolveTenantPhoneNumber(
  context: TenantContext,
  phoneNumberId: string,
): Promise<OwnedPhoneNumber> {
  const phone = await prisma.phoneNumber.findFirst({
    where: { id: phoneNumberId, wabaAccount: { tenantId: context.tenantId } },
    include: { wabaAccount: true },
  });
  return assertOwner(context, phone as OwnedPhoneNumber | null);
}

export async function resolveTenantWabaAccount(context: TenantContext, wabaAccountId: string) {
  assertTrustedTenantContext(context);
  const account = await prisma.wabaAccount.findFirst({
    where: { id: wabaAccountId, tenantId: context.tenantId },
  });
  if (!account) throw new TenantAuthorizationError();
  return account;
}

/**
 * Lazily provision a tenant-bound WabaAccount + PhoneNumber for the legacy
 * global WabaSettings singleton, so existing single-WABA installations keep
 * receiving inbound messages after the multi-tenant migration.
 *
 * - The legacy `WabaSettings` row carries the real Meta credentials and a
 *   WABA id that is unique per Meta account.
 * - We pick the most recent active tenant (any tenant works as long as the
 *   operator confirms) and create the WabaAccount + PhoneNumber under it.
 * - Historical contact / conversation rows that were created under the
 *   pre-tenant singleton model carry `tenantId = null` and
 *   `phoneNumberId = null`; we bind them to the new phone as part of the
 *   migration so existing customer history stays visible.
 * - If a phone number already exists for this Meta id we return it.
 * - If there is no legacy config or no tenants at all, the call throws so
 *   the inbound processor records a clear error.
 */
async function provisionFromLegacySettings(
  metaPhoneNumberId: string,
): Promise<OwnedPhoneNumber | null> {
  const legacy = await prisma.wabaSettings.findUnique({ where: { id: "default" } });
  if (!legacy?.wabaId) return null;

  const existing = await prisma.phoneNumber.findFirst({
    where: { metaPhoneNumberId },
    include: { wabaAccount: true },
  });
  if (existing) return existing as OwnedPhoneNumber;

  // Pick the most recent tenant as the destination for this WABA. The
  // operator can re-link the WABA from the Settings UI later if needed.
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: "desc" } });
  if (!tenant) return null;

  const waba = await prisma.wabaAccount.upsert({
    where: { tenantId_metaWabaId: { tenantId: tenant.id, metaWabaId: legacy.wabaId } },
    update: {},
    create: {
      tenantId: tenant.id,
      metaWabaId: legacy.wabaId,
      name: legacy.businessName ?? null,
      metaAppId: legacy.metaAppId ?? null,
      accessTokenEnc: legacy.accessTokenEnc,
      appSecret: legacy.appSecret ?? null,
      apiVersion: legacy.apiVersion,
    },
  });

  const phone = await prisma.phoneNumber.upsert({
    where: { wabaAccountId_metaPhoneNumberId: { wabaAccountId: waba.id, metaPhoneNumberId } },
    update: {
      displayPhone: legacy.phoneNumberDisplay ?? undefined,
      verifiedName: legacy.businessName ?? undefined,
    },
    create: {
      wabaAccountId: waba.id,
      metaPhoneNumberId,
      displayPhone: legacy.phoneNumberDisplay,
      verifiedName: legacy.businessName,
    },
    include: { wabaAccount: true },
  });

  // Bind historical unbound rows to the new phone + tenant. This is a
  // one-time migration that brings pre-tenant data into the new model so
  // the customer keeps seeing their previous conversation history.
  await prisma.$transaction([
    prisma.conversation.updateMany({
      where: { phoneNumberId: null },
      data: { phoneNumberId: phone.id, tenantId: tenant.id },
    }),
    prisma.contact.updateMany({
      where: { tenantId: null },
      data: { tenantId: tenant.id },
    }),
  ]);

  return phone as OwnedPhoneNumber;
}

export async function resolveInboundPhoneNumber(metaPhoneNumberId: string): Promise<OwnedPhoneNumber> {
  const phones = await prisma.phoneNumber.findMany({
    where: { metaPhoneNumberId },
    include: { wabaAccount: true },
  }) as OwnedPhoneNumber[];
  if (phones.length === 1) return phones[0];

  // Lazy migration: if no tenant-scoped record exists, try to bridge from
  // the legacy global WabaSettings. This keeps existing single-WABA
  // installations receiving webhooks after the multi-tenant migration.
  if (phones.length === 0) {
    const provisioned = await provisionFromLegacySettings(metaPhoneNumberId);
    if (provisioned) return provisioned;
  }
  throw new TenantAuthorizationError(
    `Unable to resolve inbound phone number ${metaPhoneNumberId} to a tenant (found ${phones.length} records)`,
  );
}

export function phoneNumberConfig(phone: OwnedPhoneNumber): WabaConfig {
  return {
    wabaId: phone.wabaAccount.metaWabaId,
    metaAppId: phone.wabaAccount.metaAppId ?? null,
    phoneNumberId: phone.metaPhoneNumberId,
    phoneNumberDisplay: phone.displayPhone,
    businessName: phone.verifiedName ?? phone.wabaAccount.name,
    accessToken: phone.wabaAccount.accessTokenEnc ? decrypt(phone.wabaAccount.accessTokenEnc) : null,
    appSecret: phone.wabaAccount.appSecret ?? null,
    webhookVerifyToken: null,
    apiVersion: phone.wabaAccount.apiVersion ?? "v21.0",
  };
}
