import { handle, ok, requireAdmin, HttpError } from "@/lib/api";
import { getTenantWabaConfig } from "@/lib/settings";
import { requireTenantAdminApi } from "@/lib/tenant/page-guards";
import { uploadTemplateMediaSample } from "@/lib/whatsapp/upload";

export const POST = handle(async (req) => {
  const session = await requireAdmin();
  const form = await req.formData();
  const file = form.get("file");
  const tenantId = form.get("tenantId");
  if (!(file instanceof File)) throw new HttpError(400, "No file provided");
  if (typeof tenantId !== "string" || !tenantId) throw new HttpError(400, "Tenant WABA is required for sample upload.");
  await requireTenantAdminApi(session.user.id, tenantId);
  const config = await getTenantWabaConfig(tenantId);
  if (!config) throw new HttpError(400, "Tenant WhatsApp is not connected.");

  const buffer = Buffer.from(await file.arrayBuffer());
  const handle = await uploadTemplateMediaSample({
    data: buffer,
    mimeType: file.type || "application/octet-stream",
    fileName: file.name || "sample",
    config,
  });

  return ok({ handle, filename: file.name, mime: file.type });
});
