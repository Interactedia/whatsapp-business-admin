import { handle, ok, requireUser, HttpError } from "@/lib/api";
import { requireTenantAdminApi } from "@/lib/tenant/page-guards";
import { getTenantWabaConfig, updateTenantWabaConfig } from "@/lib/settings";
import { graphFetch, WhatsAppApiError } from "@/lib/whatsapp/client";

type PhoneNumberInfo = {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
};

export const POST = handle(async (_req, { params }) => {
  const session = await requireUser();
  const { tenantId } = await params;
  await requireTenantAdminApi(session.user.id, tenantId);

  const cfg = await getTenantWabaConfig(tenantId);
  if (!cfg?.phoneNumberId) throw new HttpError(400, "Set the Phone Number ID first");
  if (!cfg?.accessToken) throw new HttpError(400, "Set the Access Token first");

  try {
    const info = await graphFetch<PhoneNumberInfo>({
      method: "GET",
      path: `/${cfg.phoneNumberId}`,
      query: { fields: "display_phone_number,verified_name,quality_rating" },
      config: cfg,
      related: { type: "settings" },
    });

    await updateTenantWabaConfig(tenantId, {
      phoneNumberDisplay: info.display_phone_number ?? null,
      businessName: info.verified_name ?? null,
    });

    return ok({
      success: true,
      displayPhoneNumber: info.display_phone_number,
      verifiedName: info.verified_name,
      qualityRating: info.quality_rating,
    });
  } catch (e) {
    if (e instanceof WhatsAppApiError) {
      return ok({ success: false, message: e.message, code: e.code }, 200);
    }
    throw e;
  }
});
