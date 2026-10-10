import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";
import { WhatsAppApiError } from "./client";
import { ensureConversation, isWithinSessionWindow, sendMessage } from "./send";
import { flowTokenHash, newFlowToken } from "./flow-crypto";
import type { FlowJson } from "./flow-types";
import type { ApiComponent } from "./template-types";

export async function launchFlow(input: {
  flowId: string;
  tenantId?: string;
  to: string;
  sentById?: string;
  cta?: string;
  body?: string;
  header?: string;
  footer?: string;
  entryScreen?: string;
  initialData?: Record<string, unknown>;
}) {
  const flow = await prisma.flow.findFirst({ where: { id: input.flowId, ...(input.tenantId ? { tenantId: input.tenantId } : {}) }, include: { versions: { where: { status: "PUBLISHED" }, orderBy: { revision: "desc" }, take: 1 } } });
  const publishedVersion = flow?.versions[0];
  if (!flow) throw new WhatsAppApiError(404, "Flow not found.");
  if (!publishedVersion?.metaFlowId) throw new WhatsAppApiError(409, "Only published Flows can be launched.");
  const json = publishedVersion.flowJson as unknown as FlowJson;
  const entryScreen = input.entryScreen || json.screens[0]?.id;
  if (!entryScreen || !json.screens.some((screen) => screen.id === entryScreen)) throw new WhatsAppApiError(400, "Entry screen does not exist in this Flow.");
  const { contact, conversation } = await ensureConversation(input.to);
  if (input.tenantId && (contact.tenantId !== input.tenantId || conversation.tenantId !== input.tenantId)) throw new WhatsAppApiError(404, "Conversation not found.");
  if (!isWithinSessionWindow(conversation.lastInboundAt)) {
    throw new WhatsAppApiError(403, "Direct Flows can only be sent within the 24-hour window. Use an approved message template outside it.");
  }
  const token = newFlowToken();
  const launch = await prisma.flowLaunch.create({
    data: {
      flowId: flow.id,
      flowVersionId: publishedVersion.id,
      contactId: contact.id,
      conversationId: conversation.id,
      tokenHash: flowTokenHash(token),
      tokenPrefix: token.slice(0, 12),
      initialDataEnc: input.initialData ? encrypt(JSON.stringify(input.initialData)) : null,
      entryScreen,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  try {
    const message = await sendMessage({
      conversationId: conversation.id,
      to: input.to,
      sentById: input.sentById,
      content: {
        kind: "flow",
        flowId: publishedVersion.metaFlowId,
        flowToken: token,
        cta: input.cta || "Open form",
        body: input.body || `Please complete ${flow.name}.`,
        header: input.header,
        footer: input.footer,
        entryScreen,
        initialData: input.initialData,
        action: publishedVersion.endpointEnabled ? "data_exchange" : "navigate",
      },
    });
    await prisma.flowLaunch.update({ where: { id: launch.id }, data: { status: "SENT", messageId: message.id } });
    return { launchId: launch.id, messageId: message.waMessageId, conversationId: conversation.id };
  } catch (error) {
    await prisma.flowLaunch.update({ where: { id: launch.id }, data: { status: "FAILED", error: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}

export async function prepareTemplateFlowLaunch(input: {
  templateComponents: ApiComponent[];
  contactId: string;
  conversationId: string;
  initialData?: Record<string, unknown>;
}) {
  const buttons = input.templateComponents.find((component) => component.type === "BUTTONS");
  const index = buttons?.type === "BUTTONS" ? buttons.buttons.findIndex((button) => button.type === "FLOW") : -1;
  if (!buttons || buttons.type !== "BUTTONS" || index < 0) return null;
  const button = buttons.buttons[index];
  if (button.type !== "FLOW") return null;
  const version = await prisma.flowVersion.findUnique({ where: { metaFlowId: button.flow_id }, include: { flow: true } });
  if (!version || version.status !== "PUBLISHED") throw new WhatsAppApiError(409, "The template references a Flow that is not published locally.");
  const token = newFlowToken();
  const launch = await prisma.flowLaunch.create({
    data: {
      flowId: version.flowId,
      flowVersionId: version.id,
      contactId: input.contactId,
      conversationId: input.conversationId,
      tokenHash: flowTokenHash(token),
      tokenPrefix: token.slice(0, 12),
      initialDataEnc: input.initialData ? encrypt(JSON.stringify(input.initialData)) : null,
      entryScreen: button.navigate_screen,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  return {
    launchId: launch.id,
    sendComponent: {
      type: "button",
      sub_type: "flow",
      index: String(index),
      parameters: [{ type: "action", action: { flow_token: token, ...(input.initialData ? { flow_action_data: input.initialData } : {}) } }],
    },
  };
}

export async function finishPreparedFlowLaunch(launchId: string, messageId?: string, error?: unknown) {
  await prisma.flowLaunch.update({
    where: { id: launchId },
    data: error ? { status: "FAILED", error: error instanceof Error ? error.message : String(error) } : { status: "SENT", messageId },
  });
}
