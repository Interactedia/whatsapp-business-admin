import { handle, ok, requireUser, HttpError } from "@/lib/api";
import { requireWebhookDestinationAdminApi } from "@/lib/tenant/page-guards";
import { listWebhookDeliveryHistory } from "@/lib/events/webhook-destinations";

export const GET = handle(async (req, { params }) => {
  const session = await requireUser();
  const { tenantId, destinationId } = await params;
  await requireWebhookDestinationAdminApi(session.user.id, tenantId);
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? "50");
  const history = await listWebhookDeliveryHistory(tenantId, destinationId, Number.isFinite(limit) ? limit : 50);
  if (!history) throw new HttpError(404, "Webhook destination not found");
  return ok({ history });
});
