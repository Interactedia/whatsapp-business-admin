import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { handle, ok, requireAdmin, HttpError } from "@/lib/api";

const createSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  role: z.enum(["SYSTEM_ADMIN", "ADMIN", "AGENT"]),
});

export const GET = handle(async () => {
  const session = await requireAdmin();

  // SYSTEM_ADMIN sees all users globally
  if (session.user.role === "SYSTEM_ADMIN") {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, email: true, role: true, active: true, createdAt: true },
    });
    return ok(users);
  }

  // Tenant ADMIN sees only users who are members of their tenant
  const memberships = await prisma.tenantMembership.findMany({
    where: { userId: session.user.id },
    select: { tenantId: true },
  });
  const tenantIds = memberships.map((m) => m.tenantId);

  if (tenantIds.length === 0) {
    // ADMIN with no tenant membership sees nothing
    return ok([]);
  }

  // Get users who are members of any of the caller's tenants
  const userIds = await prisma.tenantMembership.findMany({
    where: { tenantId: { in: tenantIds } },
    select: { userId: true },
  });
  const uniqueUserIds = [...new Set(userIds.map((u) => u.userId))];

  const users = await prisma.user.findMany({
    where: { id: { in: uniqueUserIds } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, email: true, role: true, active: true, createdAt: true },
  });
  return ok(users);
});

export const POST = handle(async (req) => {
  const session = await requireAdmin();
  const body = createSchema.parse(await req.json());

  // Privilege boundary: only a SYSTEM_ADMIN can create another SYSTEM_ADMIN.
  if (body.role === "SYSTEM_ADMIN" && session.user.role !== "SYSTEM_ADMIN") {
    throw new HttpError(403, "Only a system administrator can manage system administrator accounts");
  }

  const exists = await prisma.user.findUnique({ where: { email: body.email } });
  if (exists) throw new HttpError(409, "A user with that email already exists");

  const passwordHash = await bcrypt.hash(body.password, 10);
  const user = await prisma.user.create({
    data: { name: body.name, email: body.email, role: body.role, passwordHash },
    select: { id: true, name: true, email: true, role: true, active: true, createdAt: true },
  });

  // Tenant ADMIN: auto-add new user to the caller's tenant
  if (session.user.role !== "SYSTEM_ADMIN") {
    const memberships = await prisma.tenantMembership.findMany({
      where: { userId: session.user.id },
      select: { tenantId: true },
    });
    if (memberships.length > 0) {
      // Add to the first tenant (ADMIN should typically be in one tenant)
      await prisma.tenantMembership.create({
        data: { userId: user.id, tenantId: memberships[0].tenantId },
      });
    }
  }

  return ok(user, 201);
});
