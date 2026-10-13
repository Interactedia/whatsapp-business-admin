import { handle, ok, requireAdmin, HttpError } from "@/lib/api";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantAdminApi } from "@/lib/tenant/page-guards";
import { syncFlowsForTenant } from "@/lib/whatsapp/flow-service";

export const POST = handle(async (req) => {
  await requireAdmin();
  const session = await auth();
  let body: { tenantId?: string } = {};
  try {
    body = (await req.json()) as { tenantId?: string };
  } catch {
    body = {};
  }
  const tenantId = body.tenantId ?? (
    session?.user?.id
      ? (await prisma.tenantMembership.findFirst({
          where: { userId: session.user.id, user: { active: true } },
          orderBy: { createdAt: "asc" },
          select: { tenantId: true },
        }))?.tenantId
      : null
  );
  if (!tenantId) throw new HttpError(400, "Could not determine tenant for flow sync.");
  if (!session?.user?.id) throw new HttpError(401, "Unauthorized");
  await requireTenantAdminApi(session.user.id, tenantId);

  return ok(await syncFlowsForTenant(tenantId));
});
