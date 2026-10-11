import { prisma } from "@/lib/prisma";
import { handle, ok, requireUser } from "@/lib/api";
import { requireTenantAdminApi } from "@/lib/tenant/page-guards";
import { getTenantWabaConfig } from "@/lib/settings";
import { graphFetch, WhatsAppApiError } from "@/lib/whatsapp/client";
import { createAndActivateFlowKey, getFlowKeyHealth } from "@/lib/whatsapp/flow-crypto";

export const GET = handle(async (_req, { params }) => {
  const session = await requireUser();
  const { tenantId } = await params;
  await requireTenantAdminApi(session.user.id, tenantId);

  return ok(await getFlowKeyHealth());
});

export const POST = handle(async (_req, { params }) => {
  const session = await requireUser();
  const { tenantId } = await params;
  await requireTenantAdminApi(session.user.id, tenantId);

  const config = await getTenantWabaConfig(tenantId);
  if (!config?.phoneNumberId) throw new WhatsAppApiError(400, "Set the Phone Number ID first.");
  if (!config?.accessToken) throw new WhatsAppApiError(400, "Set the Access Token first.");

  const key = await createAndActivateFlowKey();
  const form = new FormData();
  form.set("business_public_key", key.publicKey);
  await graphFetch({
    method: "POST",
    path: `/${config.phoneNumberId}/whatsapp_business_encryption`,
    body: form,
    related: { type: "flow-encryption-key", id: key.fingerprint },
    config,
  });
  await prisma.flowEncryptionKey.update({
    where: { fingerprint: key.fingerprint },
    data: { registeredAt: new Date() },
  });
  return ok({ configured: true, fingerprint: key.fingerprint, registeredAt: new Date() });
});
