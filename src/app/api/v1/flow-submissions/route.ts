import { prisma } from "@/lib/prisma";
import { resolveApiKeyTenantContext } from "@/lib/tenant";
import { apiOk, requireApiKey, v1Handle } from "@/lib/v1";
import { presentFlowSubmission } from "@/lib/whatsapp/flow-present";

export const GET = v1Handle(async (req) => {
  const context = await resolveApiKeyTenantContext(await requireApiKey(req));
  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor") || undefined;
  const flowId = url.searchParams.get("flow_id") || undefined;
  const rows = await prisma.flowSubmission.findMany({
    where: { launch: { flow: { tenantId: context.tenantId }, contact: { tenantId: context.tenantId }, ...(flowId ? { flowId } : {}) } },
    include: { launch: { include: { flow: true, contact: true } } },
    orderBy: { completedAt: "desc" },
    take: 51,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const data = rows.slice(0, 50).map((row) => ({ ...presentFlowSubmission(row, true), contact: { id: row.launch.contact.id, wa_id: row.launch.contact.waId } }));
  return apiOk({ data, next_cursor: rows.length > 50 ? data[data.length - 1]?.id : null });
});
