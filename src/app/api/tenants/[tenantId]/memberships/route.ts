import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { handle, ok, requireUser, HttpError } from "@/lib/api";

const addMemberSchema = z.object({
  userId: z.string().trim().min(1, "User ID is required"),
});

export const GET = handle(async (_req, { params }) => {
  const session = await requireUser();
  const { tenantId } = await params;

  // Verify target tenant exists
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    throw new HttpError(404, "Tenant not found");
  }

  // Authorization check: must be SYSTEM_ADMIN or an active member of this tenant
  const isSysAdmin = session.user.role === "SYSTEM_ADMIN";
  if (!isSysAdmin) {
    const membership = await prisma.tenantMembership.findUnique({
      where: { userId_tenantId: { userId: session.user.id, tenantId } },
      select: { user: { select: { active: true } } },
    });
    if (!membership?.user.active) {
      throw new HttpError(403, "Must be a member of the tenant to view its memberships");
    }
  }

  const members = await prisma.tenantMembership.findMany({
    where: {
      tenantId,
      // Exclude SYSTEM_ADMIN accounts - they have no tenant context
      user: { role: { not: "SYSTEM_ADMIN" } },
    },
    select: {
      id: true,
      userId: true,
      tenantId: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          active: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return ok(members);
});

export const POST = handle(async (req, { params }) => {
  const session = await requireUser();
  const { tenantId } = await params;

  // Verify target tenant exists
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    throw new HttpError(404, "Tenant not found");
  }

  // Authorization: must be SYSTEM_ADMIN OR an active ADMIN of this specific tenant
  const isSysAdmin = session.user.role === "SYSTEM_ADMIN";
  if (!isSysAdmin) {
    const callerMembership = await prisma.tenantMembership.findUnique({
      where: { userId_tenantId: { userId: session.user.id, tenantId } },
      select: { user: { select: { role: true, active: true } } },
    });
    if (!callerMembership?.user.active || callerMembership.user.role !== "ADMIN") {
      throw new HttpError(403, "Tenant administrator authority required to manage memberships");
    }
  }

  const body = addMemberSchema.parse(await req.json());

  // Verify target user exists, is active, and is not a SYSTEM_ADMIN
  const targetUser = await prisma.user.findUnique({
    where: { id: body.userId },
    select: { id: true, active: true, name: true, email: true, role: true },
  });
  if (!targetUser || !targetUser.active) {
    throw new HttpError(404, "User not found or inactive");
  }
  // SYSTEM_ADMIN cannot be added to any tenant - they have no tenant context
  if (targetUser.role === "SYSTEM_ADMIN") {
    throw new HttpError(403, "System administrator accounts cannot be added to tenants");
  }

  // Prevent duplicate memberships
  const existing = await prisma.tenantMembership.findUnique({
    where: { userId_tenantId: { userId: targetUser.id, tenantId } },
  });
  if (existing) {
    throw new HttpError(409, "User is already a member of this tenant");
  }

  // Create membership
  const membership = await prisma.tenantMembership.create({
    data: {
      userId: targetUser.id,
      tenantId,
    },
    select: {
      id: true,
      userId: true,
      tenantId: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          active: true,
        },
      },
    },
  });

  return ok(membership, 201);
});

/**
 * DELETE /api/tenants/:tenantId/memberships?userId=<id>
 *
 * Removes the User <-> Tenant membership only. The User row, its other
 * memberships and all historical tenant data (conversations, messages,
 * contacts, logs, audit records) are left untouched.
 *
 * Authorization: global administrative operation, SYSTEM_ADMIN only. Tenant
 * ADMINs without global authority are rejected (mirrors the /admin/tenants
 * page guard). Revocation is immediate: every tenant-scoped guard
 * (verifyMembership / resolveTenantContext) reads the DB per request, so an
 * existing session loses effective access on the next call.
 */
export const DELETE = handle(async (req, { params }) => {
  const session = await requireUser();
  if (session.user.role !== "SYSTEM_ADMIN") {
    throw new HttpError(403, "System administrator authority required to remove members");
  }

  const { tenantId } = await params;
  const url = new URL(req.url);
  const parsed = addMemberSchema.safeParse({ userId: url.searchParams.get("userId") ?? "" });
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues[0]?.message ?? "User ID is required");
  }
  const { userId } = parsed.data;

  const [tenant, targetUser, membership] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, active: true } }),
    prisma.tenantMembership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
      select: { id: true },
    }),
  ]);
  if (!tenant) throw new HttpError(404, "Tenant not found");
  if (!targetUser) throw new HttpError(404, "User not found");
  if (!membership) throw new HttpError(404, "Membership not found");

  // Serialize concurrent removals on the same tenant so two simultaneous
  // deletes cannot both pass the last-admin check.
  // ponytail: per-tenant advisory xact lock; a real DB constraint would need a schema change (out of scope).
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`;

    // Last-admin protection. The system represents the tenant administrator as
    // a global User.role === "ADMIN" with a membership in the tenant (see
    // lib/tenant/page-guards.ts); TenantMembership itself carries no role.
    if (targetUser.role === "ADMIN") {
      const remainingAdmins = await tx.tenantMembership.count({
        where: {
          tenantId,
          userId: { not: userId },
          user: { role: "ADMIN", active: true },
        },
      });
      if (remainingAdmins === 0) {
        throw new HttpError(409, "Cannot remove the last administrator of this organization");
      }
    }

    await tx.tenantMembership.delete({ where: { id: membership.id } });
  });

  return ok({ deleted: true, userId, tenantId });
});
