import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getWabaConfig } from "@/lib/settings";
import { verifySignature, processWebhook } from "@/lib/whatsapp/webhook";
import { redactFlowWebhookPayload } from "@/lib/whatsapp/flow-submission";
import { classifyWebhookPayload } from "@/lib/whatsapp/inbound/classify";
import { isInboundAsyncEnabled } from "@/lib/whatsapp/inbound/config";
import { persistInboundWebhookReceipt } from "@/lib/whatsapp/inbound/receipt";

/** Meta webhook verification handshake. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token) {
    const cfg = await getWabaConfig();
    if (cfg.webhookVerifyToken && token === cfg.webhookVerifyToken) {
      return new NextResponse(challenge ?? "", { status: 200 });
    }
    const tenantWaba = await prisma.wabaAccount.findFirst({
      where: { webhookVerifyToken: token },
    });
    if (tenantWaba) {
      return new NextResponse(challenge ?? "", { status: 200 });
    }
  }
  return new NextResponse("Forbidden", { status: 403 });
}

/**
 * Inbound webhook events. We ALWAYS store the raw payload first (even if the
 * signature is invalid or processing throws), then verify + process.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const signature = req.headers.get("x-hub-signature-256");

  const cfg = await getWabaConfig();
  let signatureValid = cfg.appSecret ? verifySignature(raw, signature, cfg.appSecret) : false;
  if (!signatureValid && signature) {
    const tenantAccounts = await prisma.wabaAccount.findMany({
      where: { appSecret: { not: null } },
      select: { appSecret: true },
    });
    for (const acc of tenantAccounts) {
      if (acc.appSecret && verifySignature(raw, signature, acc.appSecret)) {
        signatureValid = true;
        break;
      }
    }
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { raw };
  }

  const safePayload = redactFlowWebhookPayload(payload);

  // If an app secret is configured, reject unsigned/invalid events (but keep the record).
  if (cfg.appSecret && !signatureValid) {
    const event = await prisma.webhookEvent.create({
      data: { payload: safePayload as object, signatureValid, processedOk: false },
    });
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { error: "Invalid signature", eventSummary: "rejected: bad signature" },
    });
    // Still return 200 so Meta doesn't retry a spoofed request forever.
    return NextResponse.json({ received: true });
  }

  const classification = classifyWebhookPayload(payload);
  const canUseAsyncInbound = isInboundAsyncEnabled()
    && classification.hasInboundMessages
    && !classification.hasStatuses
    && !classification.hasTemplateStatuses
    && !classification.hasFlowReplies;

  if (canUseAsyncInbound) {
    await persistInboundWebhookReceipt({ payload, signatureValid });
    return NextResponse.json({ received: true });
  }

  const event = await prisma.webhookEvent.create({
    data: { payload: safePayload as object, signatureValid, processedOk: false },
  });

  try {
    const summary = await processWebhook(payload);
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { processedOk: true, eventSummary: summary },
    });
  } catch (e) {
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { error: e instanceof Error ? e.message : String(e), eventSummary: "processing error" },
    });
    console.error("Webhook processing error:", e);
  }

  // Always 200 quickly so Meta considers it delivered.
  return NextResponse.json({ received: true });
}
