import { v1Handle, apiOk, requireApiKey, ApiError } from "@/lib/v1";
import { prisma } from "@/lib/prisma";

/** GET /api/v1/status — connection status of the WhatsApp account. */
export const GET = v1Handle(async (req) => {
  const principal = await requireApiKey(req);
  if (!principal.tenantId) throw new ApiError(403, "API key is not tenant-scoped");

  const wabaAccount = await prisma.wabaAccount.findFirst({
    where: { tenantId: principal.tenantId },
    include: { phoneNumbers: true }
  });

  return apiOk({
    data: {
      connected: Boolean(wabaAccount?.phoneNumbers[0]?.metaPhoneNumberId && wabaAccount?.accessTokenEnc),
      phone_number: wabaAccount?.phoneNumbers[0]?.displayPhone,
      business_name: wabaAccount?.name,
      api_version: wabaAccount?.apiVersion,
    },
  });
});
