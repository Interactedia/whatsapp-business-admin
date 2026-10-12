import { handle, ok, requireUser, HttpError } from "@/lib/api";
import { requireWebhookDestinationAdminApi } from "@/lib/tenant/page-guards";
import { rotateWebhookDestinationSecret } from "@/lib/events/webhook-destinations";

export const POST = handle(async (_req, { params }) => {
  const session = await requireUser();
  const { tenantId, destinationId } = await params;
  await requireWebhookDestinationAdminApi(session.user.id, tenantId);
  const rotated = await rotateWebhookDestinationSecret(tenantId, destinationId);
  if (!rotated) throw new HttpError(404, "Webhook destination not found");
  return ok(rotated);
});
