import { prisma } from "@/lib/prisma";
import { getWabaConfig, type WabaConfig } from "@/lib/settings";
import { decrypt } from "@/lib/crypto";
import { graphFetch, WhatsAppApiError } from "@/lib/whatsapp/client";
import {
  builderToComponents,
  componentsForTemplateSubmission,
  templateParameterFormat,
  type ApiComponent,
  type TemplateBuilder,
  type TemplateCategory,
} from "@/lib/whatsapp/template-types";
import { validateTemplate } from "@/lib/whatsapp/template-validate";
import type { TemplateStatus } from "@/generated/prisma/client";

function mapMetaStatus(status: string): TemplateStatus {
  switch (status?.toUpperCase()) {
    case "APPROVED":
      return "APPROVED";
    case "REJECTED":
      return "REJECTED";
    case "PAUSED":
      return "PAUSED";
    case "DISABLED":
      return "DISABLED";
    default:
      return "PENDING";
  }
}

function getTenantWabaConfig(tenantId?: string | null): Promise<WabaConfig> {
  if (!tenantId) return getWabaConfig();
  return configForTemplate(tenantId);
}

async function configForTemplate(tenantId?: string | null): Promise<WabaConfig> {
  if (tenantId) {
    const account = await prisma.wabaAccount.findFirst({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
    });
    if (account) return wabaConfigFromAccount(account);
    throw new WhatsAppApiError(
      400,
      `Tenant ${tenantId} has no WABA account configured. Open Settings to add one.`,
    );
  }
  // ponytail: templates created before the multi-tenant migration have
  // tenantId=null. As a last-resort fallback, use the only WABA on file so
  // existing operators do not get blocked by historical drift.
  const fallback = await prisma.wabaAccount.findFirst({
    orderBy: { createdAt: "asc" },
  });
  if (fallback) return wabaConfigFromAccount(fallback);
  const legacy = await getWabaConfig();
  if (!legacy.wabaId) {
    throw new WhatsAppApiError(400, "Set your WABA ID in Settings first.");
  }
  return legacy;
}

function wabaConfigFromAccount(account: {
  metaWabaId: string;
  metaAppId: string | null;
  name: string | null;
  accessTokenEnc: string | null;
  appSecret: string | null;
  webhookVerifyToken: string | null;
  apiVersion: string;
}): WabaConfig {
  return {
    wabaId: account.metaWabaId,
    metaAppId: account.metaAppId ?? null,
    phoneNumberId: null,
    phoneNumberDisplay: null,
    businessName: account.name,
    accessToken: account.accessTokenEnc ? decrypt(account.accessTokenEnc) : null,
    appSecret: account.appSecret ?? null,
    webhookVerifyToken: account.webhookVerifyToken ?? null,
    apiVersion: account.apiVersion ?? "v21.0",
  };
}

/** Submit a locally-stored template to Meta for approval. */
export async function submitTemplate(templateId: string): Promise<{ status: TemplateStatus; metaId: string }> {
  const tmpl = await prisma.template.findUnique({ where: { id: templateId } });
  if (!tmpl) throw new WhatsAppApiError(404, "Template not found.");

  const config = await configForTemplate(tmpl.tenantId);
  if (!config.wabaId) throw new WhatsAppApiError(400, "Set your WABA ID in Settings first.");

  // Reconstruct a builder-shaped object from stored components for validation.
  const components = tmpl.components as unknown as ApiComponent[];
  const category = tmpl.category as TemplateBuilder["category"];
  const submissionComponents = componentsForTemplateSubmission(category, components);
  const parameterFormat = category === "AUTHENTICATION" ? undefined : templateParameterFormat(components);

  const payload = {
    name: tmpl.name,
    language: tmpl.language,
    category: tmpl.category,
    components: submissionComponents,
    ...(parameterFormat ? { parameter_format: parameterFormat } : {}),
  };

  const res = await graphFetch<{ id: string; status: string; category: string }>({
    method: "POST",
    path: `/${config.wabaId}/message_templates`,
    body: payload,
    related: { type: "template", id: templateId },
    config,
    diagnostics: { tenantId: tmpl.tenantId ?? undefined, wabaId: config.wabaId ?? undefined },
  });

  const status = mapMetaStatus(res.status);
  await prisma.template.update({
    where: { id: templateId },
    data: { status, metaTemplateId: res.id, rejectionReason: null },
  });
  return { status, metaId: res.id };
}

/** Build + validate a builder, returning components or throwing a 422-style error. */
export function buildValidatedComponents(builder: TemplateBuilder): ApiComponent[] {
  const errors = validateTemplate(builder);
  if (errors.length > 0) {
    throw new WhatsAppApiError(422, errors.map((e) => e.message).join(" "));
  }
  return builderToComponents(builder);
}

type MetaTemplate = {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components: ApiComponent[];
  rejected_reason?: string;
};

/** Pull template statuses from Meta and reconcile local rows. */
export async function syncTemplates(): Promise<{ synced: number }> {
  const config = await getWabaConfig();
  if (!config.wabaId) throw new WhatsAppApiError(400, "Set your WABA ID in Settings first.");

  const res = await graphFetch<{ data: MetaTemplate[] }>({
    method: "GET",
    path: `/${config.wabaId}/message_templates`,
    query: { fields: "name,status,category,language,components,id,rejected_reason", limit: 200 },
    related: { type: "template" },
    config,
  });

  let synced = 0;
  for (const t of res.data ?? []) {
    const status = mapMetaStatus(t.status);
    await prisma.template.upsert({
      where: { name_language: { name: t.name, language: t.language } },
      update: {
        status,
        category: t.category as MetaTemplate["category"] as "MARKETING" | "UTILITY" | "AUTHENTICATION",
        components: t.components as object,
        metaTemplateId: t.id,
        rejectionReason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null,
      },
      create: {
        name: t.name,
        language: t.language,
        category: (t.category as "MARKETING" | "UTILITY" | "AUTHENTICATION") ?? "UTILITY",
        status,
        components: t.components as object,
        metaTemplateId: t.id,
        rejectionReason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null,
      },
    });
    synced++;
  }
  return { synced };
}

/**
 * Build the Graph `components` (parameters) for SENDING a template, filling
 * variable slots from the template's stored example values. Shared by the inbox
 * template send and broadcasts.
 */
export function templateExampleComponents(
  components: ApiComponent[],
  category?: TemplateCategory,
): unknown[] {
  if (category === "AUTHENTICATION") {
    const body = components.find((component) => component.type === "BODY");
    const buttons = components.find((component) => component.type === "BUTTONS");
    const copyCode = buttons?.buttons.find((button) => button.type === "COPY_CODE");
    const bodyExample = body?.example;
    const code =
      (bodyExample && "body_text_named_params" in bodyExample
        ? bodyExample.body_text_named_params[0]?.example
        : bodyExample?.body_text?.[0]?.[0]) ?? copyCode?.example;

    if (!code) return [];

    // Authentication templates use Meta's fixed {{1}} body and require the
    // same OTP again for the generated copy-code URL button.
    return [
      { type: "body", parameters: [{ type: "text", text: code }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
    ];
  }

  const out: unknown[] = [];
  for (const c of components) {
    if (c.type === "HEADER" && c.format === "TEXT" && c.example) {
      const example = c.example;
      if ("header_text_named_params" in example && example.header_text_named_params.length) {
        out.push({
          type: "header",
          parameters: example.header_text_named_params.map((p) => ({ type: "text", parameter_name: p.param_name, text: p.example })),
        });
      } else if ("header_text" in example && example.header_text.length) {
        out.push({ type: "header", parameters: example.header_text.map((v) => ({ type: "text", text: v })) });
      }
    }
    if (c.type === "BODY" && c.example) {
      const example = c.example;
      if ("body_text_named_params" in example && example.body_text_named_params.length) {
        out.push({
          type: "body",
          parameters: example.body_text_named_params.map((p) => ({ type: "text", parameter_name: p.param_name, text: p.example })),
        });
      } else if ("body_text" in example && example.body_text[0]?.length) {
        out.push({ type: "body", parameters: example.body_text[0].map((v) => ({ type: "text", text: v })) });
      }
    }
  }
  return out;
}

export type TemplateBodyVariables = string[] | Record<string, string>;

/** Build send-time body parameters supplied by an inbox user. */
export function templateRuntimeComponents(
  components: ApiComponent[],
  category: TemplateCategory,
  bodyVariables: TemplateBodyVariables,
): unknown[] {
  const values = Array.isArray(bodyVariables) ? bodyVariables : Object.values(bodyVariables);

  if (category === "AUTHENTICATION") {
    const code = values[0];
    if (!code) return [];
    return [
      { type: "body", parameters: [{ type: "text", text: code }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
    ];
  }

  const body = {
    type: "body",
    parameters: Array.isArray(bodyVariables)
      ? bodyVariables.map((text) => ({ type: "text", text }))
      : Object.entries(bodyVariables).map(([parameter_name, text]) => ({
          type: "text",
          parameter_name,
          text,
        })),
  };
  const fallback = templateExampleComponents(components, category);
  const bodyIndex = fallback.findIndex((component) => (component as { type?: string }).type === "body");
  if (bodyIndex >= 0) fallback[bodyIndex] = body;
  else fallback.push(body);
  return fallback;
}

/** Delete a template both on Meta (by name) and locally. */
export async function deleteTemplate(templateId: string): Promise<void> {
  const config = await getWabaConfig();
  const tmpl = await prisma.template.findUnique({ where: { id: templateId } });
  if (!tmpl) throw new WhatsAppApiError(404, "Template not found.");

  // Only call Meta if it was actually submitted.
  if (tmpl.metaTemplateId && config.wabaId) {
    try {
      await graphFetch({
        method: "DELETE",
        path: `/${config.wabaId}/message_templates`,
        query: { name: tmpl.name },
        related: { type: "template", id: templateId },
        config,
      });
    } catch (e) {
      // If Meta already removed it, continue with the local delete.
      if (!(e instanceof WhatsAppApiError) || e.status !== 404) throw e;
    }
  }

  await prisma.template.delete({ where: { id: templateId } });
}
