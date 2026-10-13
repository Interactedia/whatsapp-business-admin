import { prisma } from "@/lib/prisma";
import { handle, ok, requireAdmin } from "@/lib/api";
import { resolveLogScope, tenantWhere } from "@/lib/logs/access";

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Unified audit log feed for SYSTEM_ADMIN.
 *   ?type=api      → outbound Graph API calls (ApiLog)
 *   ?type=webhook  → inbound webhook events (WebhookEvent)
 *
 * Filters:
 *   ?page=N
 *   ?from=ISO      (webhook/api)
 *   ?to=ISO        (webhook/api)
 *   ?method=GET|POST|DELETE|PATCH|PUT  (api only)
 *   ?endpoint=/v18.0/...               (api only, partial match)
 *   ?ok=true|false                     (api only)
 *   ?related=template|message|broadcast (api only)
 *   ?sig=valid|invalid                 (webhook only)
 *   ?processed=ok|error                (webhook only)
 */
export const GET = handle(async (req) => {
  const session = await requireAdmin();
  const url = new URL(req.url);
  const scope = await resolveLogScope(session, url.searchParams.get("tenantId"));
  const type = url.searchParams.get("type") === "webhook" ? "webhook" : "api";
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(url.searchParams.get("pageSize") || PAGE_SIZE)));
  const skip = (page - 1) * pageSize;

  // Date range
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const createdAtFilter: Record<string, unknown> = {};
  if (fromParam) {
    const fromDate = new Date(fromParam);
    if (!isNaN(fromDate.getTime())) createdAtFilter.gte = fromDate;
  }
  if (toParam) {
    const toDate = new Date(toParam);
    if (!isNaN(toDate.getTime())) createdAtFilter.lte = toDate;
  }

  if (type === "webhook") {
    const where: Record<string, unknown> = tenantWhere(scope);
    if (Object.keys(createdAtFilter).length) where.createdAt = createdAtFilter;
    const sig = url.searchParams.get("sig");
    if (sig === "valid") where.signatureValid = true;
    if (sig === "invalid") where.signatureValid = false;
    const processed = url.searchParams.get("processed");
    if (processed === "ok") where.processedOk = true;
    if (processed === "error") where.processedOk = false;

    const [items, total] = await Promise.all([
      prisma.webhookEvent.findMany({ where, include: { tenant: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" }, skip, take: pageSize }),
      prisma.webhookEvent.count({ where }),
    ]);
    return ok({ type, items, total, page, pageSize });
  }

  // API logs
  const where: Record<string, unknown> = tenantWhere(scope);
  if (Object.keys(createdAtFilter).length) where.createdAt = createdAtFilter;
  const method = url.searchParams.get("method");
  if (method) where.method = method.toUpperCase();
  const endpoint = url.searchParams.get("endpoint");
  if (endpoint) where.endpoint = { contains: endpoint, mode: "insensitive" };
  const okParam = url.searchParams.get("ok");
  if (okParam === "true") where.ok = true;
  if (okParam === "false") where.ok = false;
  const related = url.searchParams.get("related");
  if (related) where.relatedType = related;

  const [items, total] = await Promise.all([
    prisma.apiLog.findMany({ where, include: { tenant: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" }, skip, take: pageSize }),
    prisma.apiLog.count({ where }),
  ]);
  return ok({ type, items, total, page, pageSize });
});
