import { handle, ok, requireAdmin, HttpError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { resolveLogScope } from "@/lib/logs/access";

export const GET = handle(async (req, ctx) => {
  const session = await requireAdmin();
  const { type, id } = await ctx.params;
  const scope = await resolveLogScope(session, new URL(req.url).searchParams.get("tenantId"));

  if (type === "api") {
    const item = await prisma.apiLog.findUnique({ where: { id }, include: { tenant: { select: { id: true, name: true } } } });
    if (!item) throw new HttpError(404, "Log not found");
    if (!scope.systemAdmin && item.tenantId !== scope.tenantId) throw new HttpError(403, "Tenant access denied");
    if (scope.systemAdmin && scope.tenantId && item.tenantId !== scope.tenantId) throw new HttpError(404, "Log not found");
    return ok(item);
  }

  if (type === "webhook") {
    const item = await prisma.webhookEvent.findUnique({ where: { id }, include: { tenant: { select: { id: true, name: true } } } });
    if (!item) throw new HttpError(404, "Log not found");
    if (!scope.systemAdmin && item.tenantId !== scope.tenantId) throw new HttpError(403, "Tenant access denied");
    if (scope.systemAdmin && scope.tenantId && item.tenantId !== scope.tenantId) throw new HttpError(404, "Log not found");
    return ok(item);
  }

  throw new HttpError(404, "Log type not found");
});
