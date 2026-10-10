import { z } from "zod";
import { prisma } from "@/lib/prisma";

export type AuthenticatedPrincipal = {
  userId: string;
};

const trustedTenantContexts = new WeakSet<TenantContext>();

export type TenantContext = {
  tenantId: string;
  userId: string;
  membershipId: string;
};

export class TenantAuthorizationError extends Error {
  constructor(message = "Tenant access denied") {
    super(message);
    this.name = "TenantAuthorizationError";
  }
}

const idSchema = z.string().trim().min(1).max(191);

function parseId(value: string): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new TenantAuthorizationError();
  return parsed.data;
}

export async function resolveApiKeyTenantContext(
  principal: { apiKeyId: string; userId: string | null; tenantId: string | null } | null | undefined
): Promise<TenantContext> {
  if (!principal?.tenantId) throw new TenantAuthorizationError();
  const context: TenantContext = {
    tenantId: parseId(principal.tenantId),
    userId: principal.userId || principal.apiKeyId,
    membershipId: "api-key:" + principal.apiKeyId,
  };
  trustedTenantContexts.add(context);
  return context;
}

export async function resolveTenantContext(
  principal: AuthenticatedPrincipal | null | undefined,
  requestedTenantId: string | null | undefined,
): Promise<TenantContext> {
  if (!principal?.userId || !requestedTenantId) throw new TenantAuthorizationError();

  const userId = parseId(principal.userId);
  const tenantId = parseId(requestedTenantId);

  const membership = await prisma.tenantMembership.findUnique({
    where: { userId_tenantId: { userId, tenantId } },
    select: {
      id: true,
      user: { select: { id: true, active: true } },
      tenant: { select: { id: true } },
    },
  });

  if (!membership?.user.active || !membership.tenant) throw new TenantAuthorizationError();

  const context: TenantContext = {
    tenantId: membership.tenant.id,
    userId: membership.user.id,
    membershipId: membership.id,
  };
  trustedTenantContexts.add(context);
  return context;
}

export function assertTrustedTenantContext(context: TenantContext | null | undefined): asserts context is TenantContext {
  if (!context || !trustedTenantContexts.has(context)) throw new TenantAuthorizationError();
}

export type TenantOwnedResource = {
  tenantId: string | null;
};

export function assertTenantOwned(
  context: TenantContext,
  resource: TenantOwnedResource | null | undefined,
): void {
  assertTrustedTenantContext(context);
  if (!resource?.tenantId || resource.tenantId !== context.tenantId) throw new TenantAuthorizationError();
}
