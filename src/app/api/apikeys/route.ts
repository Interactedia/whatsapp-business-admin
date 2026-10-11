import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { handle, ok, requireUser } from "@/lib/api";
import { generateKey } from "@/lib/api-keys";
import { requireTenantAdminApi } from "@/lib/tenant/page-guards";

export const GET = handle(async () => {
  await requireUser();
  const keys = await prisma.apiKey.findMany({
    where: { revoked: false },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, keyPrefix: true, lastUsedAt: true, createdAt: true, tenantId: true },
  });
  return ok(keys);
});

const createSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  tenantId: z.string().trim().min(1, "Tenant is required")
});

export const POST = handle(async (req) => {
  const session = await requireUser();
  const { name, tenantId } = createSchema.parse(await req.json());

  await requireTenantAdminApi(session.user.id, tenantId);

  const gen = generateKey();

  const key = await prisma.apiKey.create({
    data: { name, keyHash: gen.keyHash, keyPrefix: gen.keyPrefix, createdById: session.user.id, tenantId },
    select: { id: true, name: true, keyPrefix: true, createdAt: true, tenantId: true },
  });

  // The plaintext is returned exactly once and never stored.
  return ok({ ...key, key: gen.plaintext }, 201);
});
