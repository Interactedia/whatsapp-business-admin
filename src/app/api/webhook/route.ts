import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processWebhook } from "@/lib/whatsapp/webhook";
import { redactFlowWebhookPayload } from "@/lib/whatsapp/flow-submission";
import { classifyWebhookPayload } from "@/lib/whatsapp/inbound/classify";
import { isInboundAsyncEnabled } from "@/lib/whatsapp/inbound/config";
import { persistInboundWebhookReceipt } from "@/lib/whatsapp/inbound/receipt";
import { isStatusAsyncEnabled } from "@/lib/whatsapp/status/config";
import { persistStatusWebhookReceipt } from "@/lib/whatsapp/status/receipt";
import { authenticateMetaWebhook, SIGNATURE_HEADER } from "@/lib/whatsapp/inbound/auth";
import {
  authRejectionDiagnostic,
  formatWebhookError,
  processingErrorDiagnostic,
  rejectionSummary,
} from "@/lib/whatsapp/inbound/diagnostics";
import { boundedPayload, payloadExpiresAt, safeHeaders } from "@/lib/diagnostics/payload";
import { resolveInboundOwnership } from "@/lib/whatsapp/inbound/ownership";

/** Meta webhook verification handshake. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token) {
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
 * Inbound Meta webhook events.
 *
 * Authentication is fail-closed and happens BEFORE any business mutation:
 * the raw payload is authenticated with HMAC-SHA256 over the unmodified
 * request bytes, and only an authenticated body is routed, enqueued, or
 * allowed to touch Contact/Conversation/Message.
 *
 * A `WebhookEvent` audit row is still written for rejected deliveries — it is
 * an observability record, not business data, and without it an operator
 * cannot see that spoofed or misconfigured traffic arrived. Rejected events
 * are marked unprocessed and carry bounded structured diagnostics.
 *
 * Always returns 200 once the delivery is recorded, so Meta does not retry a
 * rejected request indefinitely.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const signature = req.headers.get(SIGNATURE_HEADER);
  const diagnosticHeaders = safeHeaders(req.headers);

  const auth = await authenticateMetaWebhook(raw, signature);

  let payload: unknown = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { raw };
  }

  const safePayload = boundedPayload(redactFlowWebhookPayload(payload));

  if (!auth.authenticated) {
    // Fail closed: no routing, no enqueue, no domain mutation. The audit row
    // is created first so its id can serve as the correlation identifier.
    const rejected = await prisma.webhookEvent.create({
      data: {
        payload: safePayload.value as object,
        payloadTruncated: safePayload.truncated,
        headers: diagnosticHeaders,
        signatureValid: false,
        processedOk: false,
        processingStage: "rejected",
        payloadExpiresAt: payloadExpiresAt(),
      },
    });
    await prisma.webhookEvent.update({
      where: { id: rejected.id },
      data: {
        error: formatWebhookError(authRejectionDiagnostic(auth.reason, rejected.id)),
        eventSummary: rejectionSummary(auth.reason),
      },
    });
    // No secret material in the log — only the rejection category.
    console.warn(`[webhook] rejected inbound delivery: ${auth.reason}`);
    return NextResponse.json({ received: true });
  }

  const signatureValid = auth.signatureValid;
  const classification = classifyWebhookPayload(payload);
  const canUseAsyncInbound = isInboundAsyncEnabled()
    && classification.hasInboundMessages
    && !classification.hasStatuses
    && !classification.hasTemplateStatuses
    && !classification.hasFlowReplies;

  if (canUseAsyncInbound) {
    // Intentionally uncaught: a receipt failure must surface as a 5xx so Meta
    // retries the delivery. Recording it here would acknowledge (and lose) a
    // transient failure. Existing retry semantics preserved.
    await persistInboundWebhookReceipt({ payload, signatureValid });
    return NextResponse.json({ received: true });
  }

  const canUseAsyncStatus = isStatusAsyncEnabled()
    && classification.hasStatuses
    && !classification.hasInboundMessages
    && !classification.hasTemplateStatuses
    && !classification.hasFlowReplies;

  if (canUseAsyncStatus) {
    try {
      const result = await persistStatusWebhookReceipt({ payload, signatureValid });
      if (result?.webhookEventId) {
        await prisma.webhookEvent.update({ where: { id: result.webhookEventId }, data: { headers: diagnosticHeaders, payloadExpiresAt: payloadExpiresAt() } });
      }
      return NextResponse.json({ received: true });
    } catch {
      // If async receipt cannot be safely stored (e.g. unknown message, multi-phone),
      // fall through to legacy handling to preserve existing behavior and logging.
    }
  }

  const inboundResolution = await resolveInboundOwnership(payload);

  const event = await prisma.webhookEvent.create({
    data: {
      payload: safePayload.value as object,
      payloadTruncated: safePayload.truncated,
      headers: diagnosticHeaders,
      signatureValid,
      processedOk: false,
      processingStage: "received",
      tenantId: inboundResolution.tenantId,
      wabaId: inboundResolution.wabaId,
      phoneNumberId: inboundResolution.phoneId,
      payloadExpiresAt: payloadExpiresAt(),
    },
  });

  try {
    const summary = await processWebhook(payload);
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { processedOk: true, eventSummary: summary, error: null, processingStage: "processed" },
    });
  } catch (e) {
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: {
        error: formatWebhookError(processingErrorDiagnostic("inbound.processing", e, event.id)),
        eventSummary: "processing error",
        processingStage: "error",
      },
    });
    console.error("Webhook processing error:", e);
  }

  // Always 200 quickly so Meta considers it delivered.
  return NextResponse.json({ received: true });
}
