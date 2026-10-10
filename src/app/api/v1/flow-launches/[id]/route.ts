import { prisma } from "@/lib/prisma";
import { resolveApiKeyTenantContext } from "@/lib/tenant";
import { ApiError, apiOk, requireApiKey, v1Handle } from "@/lib/v1";

export const GET = v1Handle(async (req, { params }) => {
  const context = await resolveApiKeyTenantContext(await requireApiKey(req));
  const launch = await prisma.flowLaunch.findUnique({ where: { id: (await params).id }, include: { flow: true, submission: true, contact: true } });
  if (!launch) throw new ApiError(404, "Flow launch not found");
  if (launch.flow.tenantId !== context.tenantId || launch.contact.tenantId !== context.tenantId) throw new ApiError(404, "Flow launch not found");
  return apiOk({
    launch: {
      id: launch.id,
      flow_id: launch.flowId,
      flow_name: launch.flow.name,
      status: launch.status.toLowerCase(),
      message_id: launch.messageId,
      created_at: launch.createdAt,
      opened_at: launch.openedAt,
      completed_at: launch.completedAt,
      submission_id: launch.submission?.id || null,
      error: launch.error,
    },
  });
});
