import { prisma } from "@/lib/prisma";
import { handle, ok, requireAdmin, HttpError } from "@/lib/api";

const PAGE_SIZE = 50;

/**
 * Unified audit log feed.
 *   ?type=api      → outbound Graph API calls (ApiLog)
 *   ?type=webhook  → inbound webhook events (WebhookEvent)
 * Supports ?page, ?related (api only), ?ok=true|false (api only).
 */
export const GET = handle(async (req) => {
  const session = await requireAdmin();
  if (session.user.role !== "SYSTEM_ADMIN") {
    throw new HttpError(403, "System administrators only");
  }
  const url = new URL(req.url);
  const type = url.searchParams.get("type") === "webhook" ? "webhook" : "api";
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const skip = (page - 1) * PAGE_SIZE;

  if (type === "webhook") {
    const [items, total] = await Promise.all([
      prisma.webhookEvent.findMany({ orderBy: { createdAt: "desc" }, skip, take: PAGE_SIZE }),
      prisma.webhookEvent.count(),
    ]);
    return ok({ type, items, total, page, pageSize: PAGE_SIZE });
  }

  const where: Record<string, unknown> = {};
  const related = url.searchParams.get("related");
  if (related) where.relatedType = related;
  const okParam = url.searchParams.get("ok");
  if (okParam === "true") where.ok = true;
  if (okParam === "false") where.ok = false;

  const [items, total] = await Promise.all([
    prisma.apiLog.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: PAGE_SIZE }),
    prisma.apiLog.count({ where }),
  ]);
  return ok({ type, items, total, page, pageSize: PAGE_SIZE });
});
