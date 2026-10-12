import { handle, ok, requireUser, HttpError } from "@/lib/api";
import { requireWebhookDestinationAdminApi } from "@/lib/tenant/page-guards";
import { getWebhookDestination, retireWebhookDestination, updateWebhookDestination, webhookDestinationInputSchema } from "@/lib/events/webhook-destinations";

export const GET = handle(async (_req, { params }) => {
  const session = await requireUser();
  const { tenantId, destinationId } = await params;
  await requireWebhookDestinationAdminApi(session.user.id, tenantId);
  const destination = await getWebhookDestination(tenantId, destinationId);
  if (!destination) throw new HttpError(404, "Webhook destination not found");
  return ok({ destination });
});

export const PUT = handle(async (req, { params }) => {
  const session = await requireUser();
  const { tenantId, destinationId } = await params;
  await requireWebhookDestinationAdminApi(session.user.id, tenantId);
  const input = webhookDestinationInputSchema.partial().parse(await req.json());
  const destination = await updateWebhookDestination(tenantId, destinationId, input);
  if (!destination) throw new HttpError(404, "Webhook destination not found");
  return ok({ destination });
});

export const DELETE = handle(async (_req, { params }) => {
  const session = await requireUser();
  const { tenantId, destinationId } = await params;
  await requireWebhookDestinationAdminApi(session.user.id, tenantId);
  const destination = await retireWebhookDestination(tenantId, destinationId);
  if (!destination) throw new HttpError(404, "Webhook destination not found");
  return ok({ destination });
});
