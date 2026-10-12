import { handle, ok, requireUser, HttpError } from "@/lib/api";
import { requireWebhookDestinationAdminApi } from "@/lib/tenant/page-guards";
import { sendSyntheticWebhookTest } from "@/lib/events/webhook-destinations";

export const POST = handle(async (_req, { params }) => {
  const session = await requireUser();
  const { tenantId, destinationId } = await params;
  await requireWebhookDestinationAdminApi(session.user.id, tenantId);
  const result = await sendSyntheticWebhookTest(tenantId, destinationId);
  if (!result) throw new HttpError(404, "Webhook destination not found or inactive");
  if (result.status === "rate_limited") throw new HttpError(429, `Test webhook rate limited. Retry after ${result.retryAfterMs}ms.`);
  return ok({ result });
});
