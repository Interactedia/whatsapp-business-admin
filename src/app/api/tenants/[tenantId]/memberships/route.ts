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
    where: { tenantId },
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

  // Verify target user exists and is active
  const targetUser = await prisma.user.findUnique({
    where: { id: body.userId },
    select: { id: true, active: true, name: true, email: true },
  });
  if (!targetUser || !targetUser.active) {
    throw new HttpError(404, "User not found or inactive");
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
