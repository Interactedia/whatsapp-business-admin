import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";
import { getTenantWabaConfig } from "@/lib/settings";
import { verifySignature } from "@/lib/whatsapp/signature";
import { decryptFlowRequest, encryptFlowResponse, flowTokenHash, FlowEndpointError, type EncryptedFlowRequest } from "@/lib/whatsapp/flow-crypto";
import { invokeFlowConnector } from "@/lib/whatsapp/flow-connector";

export async function POST(req: Request) {
  const raw = await req.text();

  let cryptoContext: Awaited<ReturnType<typeof decryptFlowRequest>> | null = null;
  try {
    cryptoContext = await decryptFlowRequest(JSON.parse(raw) as EncryptedFlowRequest);
    const request = cryptoContext.body;
    if (!request.flow_token) throw new FlowEndpointError(427, "This form is no longer available.");
    const launch = await prisma.flowLaunch.findUnique({
      where: { tokenHash: flowTokenHash(request.flow_token) },
      include: { flow: true, flowVersion: { include: { bindings: true } }, contact: true },
    });
    if (!launch || launch.expiresAt <= new Date() || ["FAILED", "EXPIRED"].includes(launch.status)) {
      throw new FlowEndpointError(427, "This form is no longer available.");
    }
    if (!launch.flow.tenantId) throw new FlowEndpointError(427, "This form is no longer available.");
    const config = await getTenantWabaConfig(launch.flow.tenantId);
    if (!config?.appSecret) return new NextResponse("Flow endpoint is not configured.", { status: 503 });
    if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), config.appSecret)) return new NextResponse(null, { status: 432 });
    if (request.action === "INIT" && launch.status === "SENT") {
      await prisma.flowLaunch.update({ where: { id: launch.id }, data: { status: "OPENED", openedAt: new Date() } });
    }
    const initialData = launch.initialDataEnc ? JSON.parse(decrypt(launch.initialDataEnc)) as Record<string, unknown> : {};
    const binding = launch.flowVersion.bindings.find((item) => item.screen === (request.screen || launch.entryScreen) && item.action === request.action);
    if (binding) {
      const response = await invokeFlowConnector({
        connectorId: binding.connectorId,
        launchId: launch.id,
        screen: request.screen,
        action: request.action,
        requestMapping: binding.requestMapping as never,
        responseMapping: binding.responseMapping as never,
        context: { request, form: request.data || {}, initial: initialData, contact: { id: launch.contact.id, waId: launch.contact.waId, name: launch.contact.name } },
      });
      return encrypted(response, cryptoContext);
    }
    if (request.action === "INIT" || request.action === "BACK") {
      return encrypted({ screen: request.screen || launch.entryScreen, data: { ...initialData, ...(request.data || {}) } }, cryptoContext);
    }
    if (request.action === "data_exchange") {
      return encrypted({ screen: "SUCCESS", data: { extension_message_response: { params: { flow_token: request.flow_token, ...(request.data || {}) } } } }, cryptoContext);
    }
    return encrypted({ screen: launch.entryScreen, data: initialData }, cryptoContext);
  } catch (error) {
    if (error instanceof FlowEndpointError) {
      if (cryptoContext && error.status === 427) return encrypted({ error_msg: error.message }, cryptoContext, error.status);
      return new NextResponse(error.message, { status: error.status });
    }
    console.error("Flow endpoint error:", error instanceof Error ? error.message : error);
    return new NextResponse("Flow endpoint error", { status: 500 });
  }
}

function encrypted(value: unknown, context: NonNullable<Awaited<ReturnType<typeof decryptFlowRequest>>>, status = 200) {
  return new NextResponse(encryptFlowResponse(value, context.aesKey, context.iv), {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}
