import { z } from "zod";
import crypto from "node:crypto";
import { handle, ok, requireAdmin } from "@/lib/api";
import { getWabaConfig, updateWabaConfig } from "@/lib/settings";
import { maskSecret } from "@/lib/crypto";
import { publicBaseUrlFromRequest } from "@/lib/public-url";

function callbackUrl(req: Request): string {
  // Build the webhook URL from the request's public host so the value the
  // user copies in Settings matches the URL Meta will actually call
  // (e.g. https://greatly-outgoing-jennet.ngrok-free.app/api/webhook when
  // reached through ngrok, not http://localhost:3000/api/webhook).
  const base = publicBaseUrlFromRequest(req).replace(/\/$/, "");
  return `${base}/api/webhook`;
}

export const GET = handle(async (req) => {
  await requireAdmin();
  const cfg = await getWabaConfig();
  return ok({
    wabaId: cfg.wabaId ?? "",
    metaAppId: cfg.metaAppId ?? "",
    phoneNumberId: cfg.phoneNumberId ?? "",
    phoneNumberDisplay: cfg.phoneNumberDisplay ?? "",
    businessName: cfg.businessName ?? "",
    apiVersion: cfg.apiVersion,
    webhookVerifyToken: cfg.webhookVerifyToken ?? "",
    accessTokenSet: Boolean(cfg.accessToken),
    accessTokenMasked: maskSecret(cfg.accessToken),
    appSecretSet: Boolean(cfg.appSecret),
    callbackUrl: callbackUrl(req),
    connected: Boolean(cfg.phoneNumberId && cfg.accessToken),
  });
});

const updateSchema = z.object({
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
  await requireAdmin();
  const body = updateSchema.parse(await req.json());

  // Auto-generate a verify token if the user left it blank. This is the
  // canonical source of truth for the token; the UI just surfaces it.
  let verifyToken = body.webhookVerifyToken;
  if (verifyToken !== undefined && verifyToken.trim() === "") {
    verifyToken = crypto.randomBytes(16).toString("hex");
  }

  await updateWabaConfig({
    wabaId: body.wabaId,
    metaAppId: body.metaAppId,
    phoneNumberId: body.phoneNumberId,
    apiVersion: body.apiVersion,
    webhookVerifyToken: verifyToken,
    // Only overwrite the token/secret when a non-empty value is provided.
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

  const cfg = await getWabaConfig();
  return ok({
    wabaId: cfg.wabaId ?? "",
    metaAppId: cfg.metaAppId ?? "",
    phoneNumberId: cfg.phoneNumberId ?? "",
    phoneNumberDisplay: cfg.phoneNumberDisplay ?? "",
    businessName: cfg.businessName ?? "",
    apiVersion: cfg.apiVersion,
    webhookVerifyToken: cfg.webhookVerifyToken ?? "",
    accessTokenSet: Boolean(cfg.accessToken),
    accessTokenMasked: maskSecret(cfg.accessToken),
    appSecretSet: Boolean(cfg.appSecret),
    callbackUrl: callbackUrl(req),
    connected: Boolean(cfg.phoneNumberId && cfg.accessToken),
  });
});
