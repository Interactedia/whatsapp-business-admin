import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { handle, HttpError, ok, requireAdmin } from "@/lib/api";
import type { Prisma } from "@/generated/prisma/client";
import type { FlowComponent, FlowJson } from "@/lib/whatsapp/flow-types";
import { FLOW_DATA_API_VERSION } from "@/lib/whatsapp/flow-types";

const mappingSource = z.object({ source: z.string().optional(), literal: z.unknown().optional() });
const schema = z.object({
  screen: z.string().min(1),
  action: z.string().min(1).default("data_exchange"),
  connectorId: z.string().min(1),
  requestMapping: z.object({ path: z.string().optional(), body: z.record(z.string(), mappingSource).optional() }),
  responseMapping: z.object({ screen: z.string().optional(), data: z.string().optional(), error: z.string().optional() }),
});

export const POST = handle(async (req, { params }) => {
  await requireAdmin();
  const { id } = await params;
  const body = schema.parse(await req.json());
  const flow = await prisma.flow.findUnique({ where: { id }, include: { activeVersion: true } });
  if (!flow?.activeVersion) throw new HttpError(404, "Flow not found");
  if (!["LOCAL", "DRAFT", "ERROR"].includes(flow.activeVersion.status)) throw new HttpError(409, "Clone the published Flow before changing bindings.");
  const data = {
    screen: body.screen,
    action: body.action,
    connectorId: body.connectorId,
    requestMapping: body.requestMapping as unknown as Prisma.InputJsonValue,
    responseMapping: body.responseMapping as unknown as Prisma.InputJsonValue,
  };
  const binding = await prisma.flowActionBinding.upsert({
    where: { flowVersionId_screen_action: { flowVersionId: flow.activeVersion.id, screen: body.screen, action: body.action } },
    update: data,
    create: { ...data, flowVersionId: flow.activeVersion.id },
  });
  const json = flow.activeVersion.flowJson as unknown as FlowJson;
  const updateFooter = (components: FlowComponent[]): boolean => {
    for (const component of components) {
      if (component.type === "Footer") {
        const previous = component["on-click-action"] as Record<string, unknown> | undefined;
        component["on-click-action"] = { ...(previous || {}), name: "data_exchange" };
        return true;
      }
      if (Array.isArray(component.children) && updateFooter(component.children)) return true;
    }
    return false;
  };
  if (body.action === "data_exchange") {
    const screen = json.screens.find((item) => item.id === body.screen);
    if (screen) updateFooter(screen.layout.children);
  }
  const routingModel = json.routing_model || Object.fromEntries(json.screens.map((screen) => [screen.id, []]));
  await prisma.flowVersion.update({
    where: { id: flow.activeVersion.id },
    data: {
      flowJson: { ...json, data_api_version: FLOW_DATA_API_VERSION, routing_model: routingModel } as unknown as Prisma.InputJsonValue,
      dataApiVersion: FLOW_DATA_API_VERSION,
      endpointEnabled: true,
    },
  });
  return ok(binding, 201);
});

export const DELETE = handle(async (req, { params }) => {
  await requireAdmin();
  const { id } = await params;
  const url = new URL(req.url);
  const bindingId = url.searchParams.get("bindingId");
  if (!bindingId) throw new HttpError(400, "bindingId is required");
  const binding = await prisma.flowActionBinding.findFirst({ where: { id: bindingId, flowVersion: { flowId: id } } });
  if (!binding) throw new HttpError(404, "Binding not found");
  await prisma.flowActionBinding.delete({ where: { id: binding.id } });
  return ok({ deleted: true });
});
