import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { HttpError } from "@/lib/api";

export async function getMemberships(userId: string) {
  return prisma.tenantMembership.findMany({
    where: {
      userId,
      user: { active: true },
    },
    select: {
      id: true,
      tenantId: true,
      tenant: { select: { id: true, name: true } },
    },
  });
}

export async function verifyMembership(userId: string, tenantId: string) {
  const membership = await prisma.tenantMembership.findUnique({
    where: { userId_tenantId: { userId, tenantId } },
    select: {
      id: true,
      user: { select: { id: true, active: true, role: true } },
      tenant: { select: { id: true, name: true } },
    },
  });
  if (!membership?.user.active || !membership.tenant) return null;
  return membership;
}

/**
 * Server Component page guard: enforces tenant-scoped ADMIN role.
 * - Redirects unauthenticated users to /login.
 * - If user has no active membership for the requested tenant, returns membership: null
 *   allowing the page to render the tenant selector.
 * - If user is an AGENT (unauthorized for administrative pages), redirects to
 *   /t/{tenantId}/conversations.
 * - If user is an ADMIN (or SYSTEM_ADMIN) with an active membership in the tenant,
 *   allows access.
 */
export async function requireTenantAdmin(tenantId: string) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  const membership = await verifyMembership(session.user.id, tenantId);
  if (!membership) {
    const memberships = await getMemberships(session.user.id);
    return { session, membership: null, memberships };
  }

  const role = membership.user.role;
  const isTenantAdmin = role === "ADMIN" || role === "SYSTEM_ADMIN";
  if (!isTenantAdmin) {
    redirect(`/t/${tenantId}/conversations`);
  }

  return { session, membership, memberships: [] };
}

/**
 * API route guard: verifies that a user is an active member and an ADMIN of the tenant.
 * Fails closed without global bypass.
 */
export async function requireTenantAdminApi(userId: string, tenantId: string) {
  const membership = await verifyMembership(userId, tenantId);
  if (!membership) {
    throw new HttpError(403, "Must be an active member of the tenant");
  }
  const role = membership.user.role;
  if (role !== "ADMIN" && role !== "SYSTEM_ADMIN") {
    throw new HttpError(403, "Tenant admin required");
  }
  return membership;
}
