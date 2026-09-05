import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";
import { handle, ok, requireAdmin } from "@/lib/api";
import { assertSafeConnectorUrl } from "@/lib/whatsapp/flow-connector";

export const GET = handle(async () => {
  await requireAdmin();
  const rows = await prisma.flowConnector.findMany({ orderBy: { name: "asc" } });
  return ok(rows.map(({ authConfigEnc, ...row }) => ({ ...row, credentialsSet: Boolean(authConfigEnc) })));
});

const schema = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().url(),
  allowedHosts: z.array(z.string().trim().min(1)).min(1),
  authType: z.enum(["NONE", "BEARER", "BASIC", "HEADER"]).default("NONE"),
  authConfig: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().min(500).max(10000).default(5000),
}).superRefine((value, ctx) => {
  if (value.authType !== "NONE" && !value.authConfig) ctx.addIssue({ code: "custom", path: ["authConfig"], message: "Credentials are required for the selected authentication type." });
  if (value.authType === "BEARER" && !value.authConfig?.token) ctx.addIssue({ code: "custom", path: ["authConfig", "token"], message: "Bearer token is required." });
  if (value.authType === "BASIC" && !value.authConfig?.username) ctx.addIssue({ code: "custom", path: ["authConfig", "username"], message: "Username is required." });
  if (value.authType === "HEADER" && (!value.authConfig?.name || !value.authConfig?.value)) ctx.addIssue({ code: "custom", path: ["authConfig"], message: "Header name and value are required." });
  if (value.authType === "HEADER" && value.authConfig?.name && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value.authConfig.name)) ctx.addIssue({ code: "custom", path: ["authConfig", "name"], message: "Header name is invalid." });
  if (Object.values(value.authConfig || {}).some((part) => /[\r\n]/.test(part))) ctx.addIssue({ code: "custom", path: ["authConfig"], message: "Credentials cannot contain line breaks." });
});

export const POST = handle(async (req) => {
  await requireAdmin();
  const body = schema.parse(await req.json());
  await assertSafeConnectorUrl(body.baseUrl, body.allowedHosts);
  const { authConfig, ...connectorData } = body;
  const row = await prisma.flowConnector.create({
    data: { ...connectorData, authConfigEnc: authConfig ? encrypt(JSON.stringify(authConfig)) : null },
  });
  return ok({ id: row.id }, 201);
});
