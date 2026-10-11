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
  await requireAdmin();
  const users = await prisma.user.findMany({
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
  return ok(user, 201);
});
