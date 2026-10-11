import { z } from "zod";
import crypto from "node:crypto";
import { handle, ok, requireUser } from "@/lib/api";
import { requireTenantAdminApi } from "@/lib/tenant/page-guards";
import { getTenantWabaConfig, updateTenantWabaConfig } from "@/lib/settings";
import { maskSecret } from "@/lib/crypto";
import { publicBaseUrlFromRequest } from "@/lib/public-url";

function callbackUrl(req: Request): string {
  const base = publicBaseUrlFromRequest(req).replace(/\/$/, "");
  return `${base}/api/webhook`;
}

export const GET = handle(async (req, { params }) => {
  const session = await requireUser();
  const { tenantId } = await params;
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
  wabaId: z.string().trim().optional(),
  metaAppId: z.string().trim().optional(),
  phoneNumberId: z.string().trim().optional(),
  apiVersion: z.string().trim().optional(),
  webhookVerifyToken: z.string().trim().optional(),
  accessToken: z.string().optional(),
  appSecret: z.string().optional(),
});

export const PUT = handle(async (req, { params }) => {
  const session = await requireUser();
  const { tenantId } = await params;
  await requireTenantAdminApi(session.user.id, tenantId);

  const body = updateSchema.parse(await req.json());

  let verifyToken = body.webhookVerifyToken;
  if (!verifyToken) {
    const existing = await getTenantWabaConfig(tenantId);
    verifyToken = existing?.webhookVerifyToken ?? crypto.randomBytes(24).toString("hex");
  }

  await updateTenantWabaConfig(tenantId, {
    wabaId: body.wabaId,
    metaAppId: body.metaAppId,
    phoneNumberId: body.phoneNumberId,
    apiVersion: body.apiVersion,
    webhookVerifyToken: verifyToken,
    accessToken: body.accessToken !== undefined ? (body.accessToken === "" ? null : body.accessToken) : undefined,
    appSecret: body.appSecret !== undefined ? (body.appSecret === "" ? null : body.appSecret) : undefined,
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
