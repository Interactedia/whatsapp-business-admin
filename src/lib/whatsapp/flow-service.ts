import { prisma } from "@/lib/prisma";
import { getWabaConfig } from "@/lib/settings";
import { graphFetch, WhatsAppApiError } from "./client";
import { emptyFlowJson, type FlowCategory, type FlowComponent, type FlowJson } from "./flow-types";
import { flowUsesEndpoint, parseFlowJson, validateFlowJson } from "./flow-validate";
import type { FlowVersionStatus, Prisma } from "@/generated/prisma/client";

type MetaFlow = {
  id: string;
  name: string;
  categories?: string[];
  status: string;
  validation_errors?: unknown[];
  json_version?: string;
  data_api_version?: string;
  preview?: { preview_url?: string; expires_at?: string };
};

function metaStatus(status: string): FlowVersionStatus {
  const normalized = status?.toUpperCase() as FlowVersionStatus;
  return ["DRAFT", "PUBLISHED", "DEPRECATED", "BLOCKED", "THROTTLED"].includes(normalized) ? normalized : "ERROR";
}

function endpointUrl(): string {
  const base = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
  return `${base}/api/whatsapp/flows/data`;
}

export async function createLocalFlow(input: {
  name: string;
  categories?: FlowCategory[];
  flowJson?: FlowJson;
  retentionDays?: number;
  createdById?: string;
}) {
  const flowJson = parseFlowJson(input.flowJson || emptyFlowJson());
  const issues = validateFlowJson(flowJson);
  const flow = await prisma.flow.create({
    data: {
      name: input.name,
      categories: input.categories?.length ? input.categories : ["OTHER"],
      retentionDays: input.retentionDays ?? 90,
      createdById: input.createdById,
      versions: {
        create: {
          revision: 1,
          flowJson: flowJson as unknown as Prisma.InputJsonValue,
          jsonVersion: flowJson.version,
          dataApiVersion: flowJson.data_api_version,
          endpointEnabled: flowUsesEndpoint(flowJson),
          validationErrors: issues as unknown as Prisma.InputJsonValue,
        },
      },
    },
    include: { versions: true },
  });
  await prisma.flow.update({ where: { id: flow.id }, data: { activeVersionId: flow.versions[0].id } });
  return flow;
}

export async function updateLocalFlowVersion(flowId: string, input: {
  name?: string;
  categories?: FlowCategory[];
  retentionDays?: number;
  sensitiveFields?: string[];
  completionWebhookUrl?: string | null;
  flowJson: FlowJson;
}) {
  const flow = await prisma.flow.findUnique({ where: { id: flowId }, include: { activeVersion: true } });
  if (!flow?.activeVersion) throw new WhatsAppApiError(404, "Flow not found.");
  if (!["LOCAL", "DRAFT", "ERROR"].includes(flow.activeVersion.status)) {
    throw new WhatsAppApiError(409, "Published Flows are immutable. Clone this Flow before editing.");
  }
  const flowJson = applySensitiveFields(parseFlowJson(input.flowJson), input.sensitiveFields ?? flow.sensitiveFields);
  const issues = validateFlowJson(flowJson);
  await prisma.$transaction([
    prisma.flow.update({
      where: { id: flowId },
      data: {
        name: input.name,
        categories: input.categories,
        retentionDays: input.retentionDays,
        sensitiveFields: input.sensitiveFields,
        completionWebhookUrl: input.completionWebhookUrl,
      },
    }),
    prisma.flowVersion.update({
      where: { id: flow.activeVersion.id },
      data: {
        flowJson: flowJson as unknown as Prisma.InputJsonValue,
        jsonVersion: flowJson.version,
        dataApiVersion: flowJson.data_api_version,
        endpointEnabled: flowUsesEndpoint(flowJson),
        validationErrors: issues as unknown as Prisma.InputJsonValue,
      },
    }),
  ]);
  return { issues };
}

function applySensitiveFields(flowJson: FlowJson, sensitiveFields: string[]): FlowJson {
  const names = (components: FlowComponent[]): string[] => components.flatMap((component) => [
    ...(component.name ? [component.name] : []),
    ...(Array.isArray(component.children) ? names(component.children) : []),
    ...(Array.isArray(component.then) ? names(component.then as FlowComponent[]) : []),
    ...(Array.isArray(component.else) ? names(component.else as FlowComponent[]) : []),
  ]);
  return {
    ...flowJson,
    screens: flowJson.screens.map((screen) => {
      const sensitive = sensitiveFields.filter((field) => names(screen.layout.children).includes(field));
      const next = { ...screen };
      if (sensitive.length) next.sensitive = sensitive;
      else delete next.sensitive;
      return next;
    }),
  };
}

async function ensureMetaDraft(flowId: string) {
  const flow = await prisma.flow.findUnique({ where: { id: flowId }, include: { activeVersion: true } });
  if (!flow?.activeVersion) throw new WhatsAppApiError(404, "Flow not found.");
  if (flow.activeVersion.metaFlowId) return { flow, version: flow.activeVersion };
  const config = await getWabaConfig();
  if (!config.wabaId) throw new WhatsAppApiError(400, "Set the WABA ID in Settings first.");
  const createForm = new FormData();
  createForm.set("name", flow.name);
  createForm.set("categories", JSON.stringify(flow.categories));
  if (flow.activeVersion.endpointEnabled) createForm.set("endpoint_uri", endpointUrl());
  const created = await graphFetch<{ id: string }>({
    method: "POST",
    path: `/${config.wabaId}/flows`,
    body: createForm,
    related: { type: "flow", id: flow.id },
    config,
  });
  const version = await prisma.flowVersion.update({
    where: { id: flow.activeVersion.id },
    data: { metaFlowId: created.id, status: "DRAFT" },
  });
  return { flow, version };
}

export async function uploadFlowDraft(flowId: string) {
  const { flow, version } = await ensureMetaDraft(flowId);
  if (!version.metaFlowId) throw new WhatsAppApiError(500, "Meta Flow ID was not created.");
  const json = parseFlowJson(version.flowJson);
  const localIssues = validateFlowJson(json);
  if (localIssues.some((issue) => issue.severity === "error")) {
    throw new WhatsAppApiError(422, localIssues.filter((i) => i.severity === "error").map((i) => i.message).join(" "));
  }

  if (version.endpointEnabled) {
    const metadata = new FormData();
    metadata.set("endpoint_uri", endpointUrl());
    metadata.set("name", flow.name);
    metadata.set("categories", JSON.stringify(flow.categories));
    await graphFetch({
      method: "POST",
      path: `/${version.metaFlowId}`,
      body: metadata,
      related: { type: "flow", id: flow.id },
    });
  }
  const form = new FormData();
  form.set("name", "flow.json");
  form.set("asset_type", "FLOW_JSON");
  form.set("file", new Blob([JSON.stringify(json)], { type: "application/json" }), "flow.json");
  const result = await graphFetch<{ success?: boolean; validation_errors?: unknown[] }>({
    method: "POST",
    path: `/${version.metaFlowId}/assets`,
    body: form,
    related: { type: "flow", id: flow.id },
  });
  const validationErrors = result.validation_errors || [];
  const preview = validationErrors.length ? null : await graphFetch<{ preview?: { preview_url?: string; expires_at?: string } }>({
    method: "GET",
    path: `/${version.metaFlowId}`,
    query: { fields: "preview.invalidate(false)" },
    related: { type: "flow", id: flow.id },
  }).catch(() => null);
  await prisma.flowVersion.update({
    where: { id: version.id },
    data: {
      status: validationErrors.length ? "ERROR" : "DRAFT",
      validationErrors: validationErrors as Prisma.InputJsonValue,
      previewUrl: preview?.preview?.preview_url,
      previewExpiresAt: preview?.preview?.expires_at ? new Date(preview.preview.expires_at) : undefined,
    },
  });
  return { metaFlowId: version.metaFlowId, validationErrors };
}

export async function publishFlow(flowId: string) {
  const uploaded = await uploadFlowDraft(flowId);
  if (uploaded.validationErrors.length) throw new WhatsAppApiError(422, "Meta rejected the Flow JSON. Resolve its validation errors first.");
  const flow = await prisma.flow.findUniqueOrThrow({ where: { id: flowId }, include: { activeVersion: true } });
  if (!flow.activeVersion?.metaFlowId) throw new WhatsAppApiError(500, "Meta Flow ID is missing.");
  await graphFetch({ method: "POST", path: `/${flow.activeVersion.metaFlowId}/publish`, related: { type: "flow", id: flowId } });
  await prisma.flowVersion.update({ where: { id: flow.activeVersion.id }, data: { status: "PUBLISHED", publishedAt: new Date(), validationErrors: [] } });
  return { status: "PUBLISHED", metaFlowId: flow.activeVersion.metaFlowId };
}

export async function cloneFlow(flowId: string) {
  const flow = await prisma.flow.findUnique({ where: { id: flowId }, include: { activeVersion: true, versions: { orderBy: { revision: "desc" }, take: 1 } } });
  if (!flow?.activeVersion) throw new WhatsAppApiError(404, "Flow not found.");
  const nextRevision = (flow.versions[0]?.revision || 0) + 1;
  let metaFlowId: string | undefined;
  if (flow.activeVersion.metaFlowId) {
    const config = await getWabaConfig();
    if (!config.wabaId) throw new WhatsAppApiError(400, "Set the WABA ID in Settings first.");
    const cloneForm = new FormData();
    cloneForm.set("name", `${flow.name} v${nextRevision}`);
    cloneForm.set("categories", JSON.stringify(flow.categories));
    cloneForm.set("clone_flow_id", flow.activeVersion.metaFlowId);
    if (flow.activeVersion.endpointEnabled) cloneForm.set("endpoint_uri", endpointUrl());
    const result = await graphFetch<{ id: string }>({
      method: "POST",
      path: `/${config.wabaId}/flows`,
      body: cloneForm,
      related: { type: "flow", id: flowId },
      config,
    });
    metaFlowId = result.id;
  }
  const version = await prisma.flowVersion.create({
    data: {
      flowId,
      revision: nextRevision,
      status: metaFlowId ? "DRAFT" : "LOCAL",
      metaFlowId,
      flowJson: flow.activeVersion.flowJson as Prisma.InputJsonValue,
      jsonVersion: flow.activeVersion.jsonVersion,
      dataApiVersion: flow.activeVersion.dataApiVersion,
      endpointEnabled: flow.activeVersion.endpointEnabled,
      clonedFromId: flow.activeVersion.id,
    },
  });
  await prisma.flow.update({ where: { id: flowId }, data: { activeVersionId: version.id } });
  return version;
}

export async function deprecateFlow(flowId: string) {
  const flow = await prisma.flow.findUnique({ where: { id: flowId }, include: { versions: { where: { status: "PUBLISHED" }, orderBy: { revision: "desc" }, take: 1 } } });
  const version = flow?.versions[0];
  if (!version?.metaFlowId) throw new WhatsAppApiError(404, "Published Meta Flow not found.");
  await graphFetch({ method: "POST", path: `/${version.metaFlowId}/deprecate`, related: { type: "flow", id: flowId } });
  await prisma.flowVersion.update({ where: { id: version.id }, data: { status: "DEPRECATED" } });
}

export async function deleteFlow(flowId: string) {
  const flow = await prisma.flow.findUnique({ where: { id: flowId }, include: { versions: true, launches: { take: 1 } } });
  if (!flow) return;
  if (flow.launches.length) throw new WhatsAppApiError(409, "Flows with launch history cannot be deleted; deprecate them instead.");
  for (const version of flow.versions) {
    if (version.status === "PUBLISHED") throw new WhatsAppApiError(409, "Published Flows must be deprecated, not deleted.");
    if (version.metaFlowId) {
      try { await graphFetch({ method: "DELETE", path: `/${version.metaFlowId}`, related: { type: "flow", id: flowId } }); }
      catch (error) { if (!(error instanceof WhatsAppApiError) || error.status !== 404) throw error; }
    }
  }
  await prisma.flow.delete({ where: { id: flowId } });
}

async function fetchMetaFlowJson(metaFlowId: string): Promise<FlowJson | null> {
  const assets = await graphFetch<{ data?: { download_url?: string }[] }>({ method: "GET", path: `/${metaFlowId}/assets`, related: { type: "flow" } });
  const url = assets.data?.[0]?.download_url;
  if (!url) return null;
  const config = await getWabaConfig();
  const response = await fetch(url, { headers: config.accessToken ? { Authorization: `Bearer ${config.accessToken}` } : undefined, redirect: "error" });
  if (!response.ok) return null;
  return parseFlowJson(await response.json());
}

export async function syncFlows() {
  const config = await getWabaConfig();
  if (!config.wabaId) throw new WhatsAppApiError(400, "Set the WABA ID in Settings first.");
  const metaFlows: MetaFlow[] = [];
  let after: string | undefined;
  do {
    const response = await graphFetch<{ data?: MetaFlow[]; paging?: { cursors?: { after?: string }; next?: string } }>({
      method: "GET",
      path: `/${config.wabaId}/flows`,
      query: { fields: "id,name,categories,status,validation_errors,json_version,data_api_version,preview", limit: 200, after },
      related: { type: "flow" },
      config,
    });
    metaFlows.push(...(response.data || []));
    after = response.paging?.next ? response.paging.cursors?.after : undefined;
  } while (after);
  let synced = 0;
  for (const item of metaFlows) {
    const existing = await prisma.flowVersion.findUnique({ where: { metaFlowId: item.id }, include: { flow: true } });
    const flowJson = await fetchMetaFlowJson(item.id).catch(() => null);
    if (existing) {
      await prisma.flowVersion.update({
        where: { id: existing.id },
        data: {
          status: metaStatus(item.status),
          validationErrors: (item.validation_errors || []) as Prisma.InputJsonValue,
          previewUrl: item.preview?.preview_url,
          previewExpiresAt: item.preview?.expires_at ? new Date(item.preview.expires_at) : undefined,
          ...(flowJson ? { flowJson: flowJson as unknown as Prisma.InputJsonValue, jsonVersion: flowJson.version, dataApiVersion: flowJson.data_api_version } : {}),
        },
      });
    } else {
      const created = await createLocalFlow({ name: item.name, categories: (item.categories || ["OTHER"]) as FlowCategory[], flowJson: flowJson || emptyFlowJson() });
      const version = created.versions[0];
      const importErrors = [...(item.validation_errors || []), ...(!flowJson ? [{ message: "Could not download the Flow JSON asset from Meta. Sync again before editing." }] : [])];
      await prisma.flowVersion.update({
        where: { id: version.id },
        data: { metaFlowId: item.id, status: flowJson ? metaStatus(item.status) : "ERROR", validationErrors: importErrors as Prisma.InputJsonValue },
      });
    }
    synced += 1;
  }
  return { synced };
}
