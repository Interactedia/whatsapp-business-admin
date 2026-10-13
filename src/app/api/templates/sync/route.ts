import { handle, ok, requireAdmin, HttpError } from "@/lib/api";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { syncTemplatesForTenant } from "@/lib/whatsapp/template-service";

export const POST = handle(async (req) => {
  await requireAdmin();
  const session = await auth();
  // ponytail: resolve the active tenant from the body (preferred, the client
  // knows which tenant is in scope) or from the caller's first membership.
  // The legacy /api/templates/sync call never carried a tenantId, so we pick
  // the caller's primary tenant and stamp a missing tenantId on every
  // reconciled row to keep multi-tenant isolation honest.
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
  if (!tenantId) throw new HttpError(400, "Could not determine tenant for template sync.");

  const result = await syncTemplatesForTenant(tenantId);
  return ok(result);
});
