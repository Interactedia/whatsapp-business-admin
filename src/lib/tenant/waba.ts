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

export async function resolveInboundPhoneNumber(metaPhoneNumberId: string): Promise<OwnedPhoneNumber> {
  const phones = await prisma.phoneNumber.findMany({
    where: { metaPhoneNumberId },
    include: { wabaAccount: true },
  }) as OwnedPhoneNumber[];
  if (phones.length !== 1) throw new TenantAuthorizationError();
  return phones[0];
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
