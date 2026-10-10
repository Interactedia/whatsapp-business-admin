import { prisma } from "@/lib/prisma";
import { resolveApiKeyTenantContext } from "@/lib/tenant";
import { apiOk, requireApiKey, v1Handle } from "@/lib/v1";

export const GET = v1Handle(async (req) => {
  const context = await resolveApiKeyTenantContext(await requireApiKey(req));
  const cursor = new URL(req.url).searchParams.get("cursor") || undefined;
  const rows = await prisma.flow.findMany({
    where: { tenantId: context.tenantId, versions: { some: { status: "PUBLISHED" } } },
    include: { versions: { where: { status: "PUBLISHED" }, orderBy: { revision: "desc" }, take: 1 } },
    orderBy: { id: "asc" },
    take: 51,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const data = rows.slice(0, 50).map((flow) => ({ id: flow.id, name: flow.name, categories: flow.categories, revision: flow.versions[0]?.revision, meta_flow_id: flow.versions[0]?.metaFlowId }));
  return apiOk({ data, next_cursor: rows.length > 50 ? data[data.length - 1]?.id : null });
});
