import { z } from "zod";
import crypto from "node:crypto";
import { handle, ok, requireUser, HttpError } from "@/lib/api";
import { requireTenantAdminApi } from "@/lib/tenant/page-guards";
import { getTenantWabaConfig, updateTenantWabaConfig } from "@/lib/settings";
import { maskSecret } from "@/lib/crypto";
import { publicBaseUrlFromRequest } from "@/lib/public-url";

function callbackUrl(req: Request): string {
  const base = publicBaseUrlFromRequest(req).replace(/\/$/, "");
  return `${base}/api/webhook`;
}

export const GET = handle(async (req) => {
  const session = await requireUser();
  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenantId");
  if (!tenantId) {
    throw new HttpError(400, "tenantId parameter is required. Settings are tenant-scoped.");
  }
  await requireTenantAdminApi(session.user.id, tenantId);

  const cfg = await getTenantWabaConfig(tenantId);
  return ok({
    wabaId: cfg?.wabaId ?? "",
    metaAppId: cfg?.metaAppId ?? "",
    phoneNumberId: cfg?.phoneNumberId ?? "",
    phoneNumberDisplay: cfg?.phoneNumberDisplay ?? "",
    businessName: cfg?.businessName ?? "",
    apiVersion: cfg?.apiVersion ?? "v21.0",
    webhookVerifyToken: cfg?.webhookVerifyToken ?? "",
    accessTokenSet: Boolean(cfg?.accessToken),
    accessTokenMasked: maskSecret(cfg?.accessToken),
    appSecretSet: Boolean(cfg?.appSecret),
    callbackUrl: callbackUrl(req),
    connected: Boolean(cfg?.phoneNumberId && cfg?.accessToken),
  });
});

const updateSchema = z.object({
  tenantId: z.string().trim().optional(),
  wabaId: z.string().trim().optional(),
  metaAppId: z.string().trim().optional(),
  phoneNumberId: z.string().trim().optional(),
  apiVersion: z.string().trim().optional(),
  webhookVerifyToken: z.string().trim().optional(),
  // Empty string clears; undefined leaves unchanged.
  accessToken: z.string().optional(),
  appSecret: z.string().optional(),
});

export const PUT = handle(async (req) => {
  const session = await requireUser();
  const url = new URL(req.url);
  const rawBody = await req.json();
  const body = updateSchema.parse(rawBody);
  const tenantId = url.searchParams.get("tenantId") || body.tenantId;
  if (!tenantId) {
    throw new HttpError(400, "tenantId parameter is required. Settings are tenant-scoped.");
  }
  await requireTenantAdminApi(session.user.id, tenantId);

  let verifyToken = body.webhookVerifyToken;
  if (verifyToken !== undefined && verifyToken.trim() === "") {
    verifyToken = crypto.randomBytes(16).toString("hex");
  }

  await updateTenantWabaConfig(tenantId, {
    wabaId: body.wabaId,
    metaAppId: body.metaAppId,
    phoneNumberId: body.phoneNumberId,
    apiVersion: body.apiVersion,
    webhookVerifyToken: verifyToken,
    accessToken:
      body.accessToken === undefined
        ? undefined
        : body.accessToken === ""
        ? null
        : body.accessToken,
    appSecret:
      body.appSecret === undefined
        ? undefined
        : body.appSecret === ""
        ? null
        : body.appSecret,
  });

  const cfg = await getTenantWabaConfig(tenantId);
  return ok({
    wabaId: cfg?.wabaId ?? "",
    metaAppId: cfg?.metaAppId ?? "",
    phoneNumberId: cfg?.phoneNumberId ?? "",
    phoneNumberDisplay: cfg?.phoneNumberDisplay ?? "",
    businessName: cfg?.businessName ?? "",
    apiVersion: cfg?.apiVersion ?? "v21.0",
    webhookVerifyToken: cfg?.webhookVerifyToken ?? "",
    accessTokenSet: Boolean(cfg?.accessToken),
    accessTokenMasked: maskSecret(cfg?.accessToken),
    appSecretSet: Boolean(cfg?.appSecret),
    callbackUrl: callbackUrl(req),
    connected: Boolean(cfg?.phoneNumberId && cfg?.accessToken),
  });
});
