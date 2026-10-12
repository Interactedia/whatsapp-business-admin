import { handle, ok, requireUser } from "@/lib/api";
import { requireWebhookDestinationAdminApi } from "@/lib/tenant/page-guards";
import { createWebhookDestination, listWebhookDestinations, webhookDestinationInputSchema } from "@/lib/events/webhook-destinations";

export const GET = handle(async (_req, { params }) => {
  const session = await requireUser();
  const { tenantId } = await params;
  await requireWebhookDestinationAdminApi(session.user.id, tenantId);
  return ok({ destinations: await listWebhookDestinations(tenantId) });
});

export const POST = handle(async (req, { params }) => {
  const session = await requireUser();
  const { tenantId } = await params;
  await requireWebhookDestinationAdminApi(session.user.id, tenantId);
  const input = webhookDestinationInputSchema.parse(await req.json());
  const created = await createWebhookDestination(tenantId, input);
  return ok(created, 201);
});
