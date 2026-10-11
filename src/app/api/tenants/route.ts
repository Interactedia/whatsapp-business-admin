import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { handle, ok, requireUser, HttpError } from "@/lib/api";

export const GET = handle(async () => {
  const session = await requireUser();
  const role = session.user.role;

  // SYSTEM_ADMIN sees all tenants
  if (role === "SYSTEM_ADMIN") {
    const tenants = await prisma.tenant.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            tenantMemberships: true,
            contacts: true,
            conversations: true,
          },
        },
      },
    });
    return ok(tenants);
  }

  // Ordinary users: authorized listing semantics (only tenants with active membership)
  const memberships = await prisma.tenantMembership.findMany({
    where: {
      userId: session.user.id,
      user: { active: true },
    },
    select: {
      tenant: {
        select: {
          id: true,
          name: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const tenants = memberships.map((m) => m.tenant).filter(Boolean);
  return ok(tenants);
});

const createSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
});

export const POST = handle(async (req) => {
  const session = await requireUser();
  if (session.user.role !== "SYSTEM_ADMIN") {
    throw new HttpError(403, "System administrator authority required to create tenants");
  }

  const body = createSchema.parse(await req.json());
  const tenant = await prisma.tenant.create({
    data: {
      name: body.name,
    },
    select: {
      id: true,
      name: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return ok(tenant, 201);
});
