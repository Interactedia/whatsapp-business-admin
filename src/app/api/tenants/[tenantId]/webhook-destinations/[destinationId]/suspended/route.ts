import { handle, ok, requireUser, HttpError } from "@/lib/api";
import { requireWebhookDestinationAdminApi } from "@/lib/tenant/page-guards";
import { prisma } from "@/lib/prisma";
import {
  listSuspendedDeliveriesForDestination,
  resumeDeliveriesForDestination,
  listDeliveryAttempts,
} from "@/lib/events/delivery-state";
import { getWebhookDestination } from "@/lib/events/webhook-destinations";

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

  return ok({ suspended: withAttempts, count: withAttempts.length });
});

export const POST = handle(async (_req, { params }) => {
  const session = await requireUser();
  const { tenantId, destinationId } = await params;
  await requireWebhookDestinationAdminApi(session.user.id, tenantId);

  const destination = await getWebhookDestination(tenantId, destinationId);
  if (!destination) throw new HttpError(404, "Webhook destination not found");
  if (!destination.enabled) throw new HttpError(409, "Cannot resume deliveries for a disabled destination.");

  const resumed = await resumeDeliveriesForDestination(prisma, { tenantId, destinationId });
  return ok({ resumed, message: `${resumed} delivery(ies) resumed.` });
});
