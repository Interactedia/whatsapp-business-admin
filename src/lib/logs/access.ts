import type { Session } from "next-auth";
import { HttpError } from "@/lib/api";
import { prisma } from "@/lib/prisma";

export type LogScope = { tenantId?: string | null; systemAdmin: boolean };

export async function resolveLogScope(session: Session, requestedTenantId: string | null): Promise<LogScope> {
  const role = session.user.role;
  if (role === "AGENT") throw new HttpError(403, "Detailed diagnostics denied");
  if (role === "SYSTEM_ADMIN") return { systemAdmin: true, tenantId: requestedTenantId || undefined };
  if (role !== "ADMIN") throw new HttpError(403, "Admins only");
  if (!requestedTenantId) throw new HttpError(403, "Tenant filter required");
  const membership = await prisma.tenantMembership.findUnique({
    where: { userId_tenantId: { userId: session.user.id, tenantId: requestedTenantId } },
  });
  if (!membership) throw new HttpError(403, "Tenant access denied");
  return { systemAdmin: false, tenantId: requestedTenantId };
}

export function tenantWhere(scope: LogScope): { tenantId?: string | null } {
  if (scope.systemAdmin) return scope.tenantId ? { tenantId: scope.tenantId } : {};
  return { tenantId: scope.tenantId! };
}
