import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { handle, ok, requireAdmin, HttpError } from "@/lib/api";

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(["SYSTEM_ADMIN", "ADMIN", "AGENT"]).optional(),
  active: z.boolean().optional(),
  password: z.string().min(8).optional(),
});

export const PATCH = handle(async (req, { params }) => {
  const session = await requireAdmin();
  const { id } = await params;
  const body = updateSchema.parse(await req.json());

  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
  if (!target) throw new HttpError(404, "User not found");

  // Privilege boundary: only a SYSTEM_ADMIN can grant/revoke SYSTEM_ADMIN,
  // or modify a SYSTEM_ADMIN account. Tenant ADMINs stay inside their scope.
  const isSystemAdmin = session.user.role === "SYSTEM_ADMIN";
  if (!isSystemAdmin && (body.role === "SYSTEM_ADMIN" || target.role === "SYSTEM_ADMIN")) {
    throw new HttpError(403, "Only a system administrator can manage system administrator accounts");
  }

  // Guard: don't let an admin lock themselves out (demote/deactivate self).
  if (id === session.user.id && (body.role === "AGENT" || body.active === false)) {
    throw new HttpError(400, "You cannot demote or deactivate your own account");
  }

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.role !== undefined) data.role = body.role;
  if (body.active !== undefined) data.active = body.active;
  if (body.password !== undefined) data.passwordHash = await bcrypt.hash(body.password, 10);

  const user = await prisma.user.update({
    where: { id },
    data,
    select: { id: true, name: true, email: true, role: true, active: true, createdAt: true },
  });
  return ok(user);
});

export const DELETE = handle(async (_req, { params }) => {
  const session = await requireAdmin();
  const { id } = await params;
  if (id === session.user.id) throw new HttpError(400, "You cannot delete your own account");
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
  if (!target) throw new HttpError(404, "User not found");
  // Only a SYSTEM_ADMIN can delete another SYSTEM_ADMIN account.
  if (target.role === "SYSTEM_ADMIN" && session.user.role !== "SYSTEM_ADMIN") {
    throw new HttpError(403, "Only a system administrator can manage system administrator accounts");
  }
  await prisma.user.delete({ where: { id } });
  return ok({ deleted: true });
});
