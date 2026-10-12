import { handle, ok, requireUser, HttpError } from "@/lib/api";
import { requireWebhookDestinationAdminApi } from "@/lib/tenant/page-guards";
import { prisma } from "@/lib/prisma";
import { listSuspendedDeliveriesForDestination, listDeliveryAttempts } from "@/lib/events/delivery-state";
import { getWebhookDestination, resolveSuspendedWebhookDeliveries } from "@/lib/events/webhook-destinations";

export const GET = handle(async (req, { params }) => {
  const session = await requireUser();
  const { tenantId, destinationId } = await params;
  await requireWebhookDestinationAdminApi(session.user.id, tenantId);

  const destination = await getWebhookDestination(tenantId, destinationId);
  if (!destination) throw new HttpError(404, "Webhook destination not found");

  const url = new URL(req.url);
  const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? "100")), 500);

  const suspended = await listSuspendedDeliveriesForDestination(prisma, { tenantId, destinationId, limit });

  // Attach last attempt summary per delivery
  const withAttempts = await Promise.all(
    suspended.map(async (delivery) => {
      const attempts = await listDeliveryAttempts(prisma, delivery.id, 5);
      return { ...delivery, attempts };
    }),
  );

  return ok({
    suspended: withAttempts,
    count: withAttempts.length,
    currentEndpointUrl: destination.endpointUrl,
    deliverySuspensionUrl: destination.deliverySuspensionUrl,
  });
});

export const POST = handle(async (req, { params }) => {
  const session = await requireUser();
  const { tenantId, destinationId } = await params;
  await requireWebhookDestinationAdminApi(session.user.id, tenantId);

  let body: { confirmEndpointUrl?: unknown; acknowledgeRecipientChange?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }

  const result = await resolveSuspendedWebhookDeliveries(tenantId, destinationId, {
    confirmEndpointUrl: typeof body.confirmEndpointUrl === "string" ? body.confirmEndpointUrl : undefined,
    acknowledgeRecipientChange: body.acknowledgeRecipientChange === true,
  });

  if (result.status === "not_found") throw new HttpError(404, "Webhook destination not found");
  if (result.status === "disabled") throw new HttpError(409, "Cannot resume deliveries for a disabled or retired destination.");
  if (result.status === "url_mismatch") {
    throw new HttpError(400, "confirmation does not match the current endpoint URL.");
  }
  if (result.status === "confirmation_required") {
    throw new HttpError(409, "The endpoint URL changed since suspension; explicit acknowledgeRecipientChange is required.");
  }

  const resumed = result.resumed ?? 0;
  return ok({ resumed, message: `${resumed} delivery(ies) resumed.` });
});
