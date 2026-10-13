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

export function detailAllowed(scope: LogScope, ownerTenantId: string | null): boolean {
  if (scope.systemAdmin) return true;
  return ownerTenantId !== null && ownerTenantId === scope.tenantId;
}

// Historical NULL-owned records stay SYSTEM_ADMIN-only; the detail endpoint
// keeps that gate. Tenant admin attempts must return 404, not 200.
export function detailAllowedForScope(scope: LogScope, ownerTenantId: string | null): "allow" | "not-found" | "forbidden" {
  if (scope.systemAdmin) return "allow";
  if (ownerTenantId === null) return "not-found";
  return ownerTenantId === scope.tenantId ? "allow" : "forbidden";
}
