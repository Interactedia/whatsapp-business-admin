import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { decrypt, encrypt } from "@/lib/crypto";
import { publish } from "@/server/realtime";
import { safePostJson } from "./flow-connector";
import { flowTokenHash } from "./flow-crypto";

export async function recordFlowSubmission(input: { waMessageId: string; responseJson: string }) {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(input.responseJson) as Record<string, unknown>; }
  catch { throw new Error("WhatsApp Flow response_json was not valid JSON."); }
  const token = typeof parsed.flow_token === "string" ? parsed.flow_token : null;
  if (!token) throw new Error("WhatsApp Flow completion did not include a flow_token.");
  const launch = await prisma.flowLaunch.findUnique({ where: { tokenHash: flowTokenHash(token) }, include: { flow: true, conversation: true } });
  if (!launch) throw new Error("WhatsApp Flow completion used an unknown token.");
  const answers = { ...parsed };
  delete answers.flow_token;
  const completedAt = new Date();
  const submission = await prisma.$transaction(async (tx) => {
    const existing = await tx.flowSubmission.findUnique({ where: { launchId: launch.id } });
    if (existing) return existing;
    const created = await tx.flowSubmission.create({
      data: {
        launchId: launch.id,
        waMessageId: input.waMessageId,
        responseEnc: encrypt(JSON.stringify(answers)),
        responseKeys: Object.keys(answers).sort(),
        completedAt,
      },
    });
    await tx.flowLaunch.update({ where: { id: launch.id }, data: { status: "COMPLETED", completedAt } });
    if (launch.flow.completionWebhookUrl && launch.flow.completionSecretEnc) {
      await tx.flowDeliveryAttempt.create({ data: { submissionId: created.id, nextAttemptAt: new Date() } });
    }
    return created;
  });
  publish({ type: "flow:submission", payload: { conversationId: launch.conversationId, submissionId: submission.id, launchId: launch.id } }, launch.conversation.tenantId);
  return submission;
}

export function redactFlowWebhookPayload<T>(payload: T): T {
  try {
    const copy = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    const directInteractive = copy.interactive as { type?: string; nfm_reply?: Record<string, unknown> } | undefined;
    if (directInteractive?.type === "nfm_reply" && directInteractive.nfm_reply) {
      directInteractive.nfm_reply.response_json = "[ENCRYPTED IN FLOW SUBMISSION]";
    }
    const entries = Array.isArray(copy.entry) ? copy.entry as Record<string, unknown>[] : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes as Record<string, unknown>[] : [];
      for (const change of changes) {
        const value = change.value as { messages?: { interactive?: { type?: string; nfm_reply?: Record<string, unknown> } }[] } | undefined;
        for (const message of value?.messages || []) {
          if (message.interactive?.type === "nfm_reply" && message.interactive.nfm_reply) {
            message.interactive.nfm_reply.response_json = "[ENCRYPTED IN FLOW SUBMISSION]";
          }
        }
      }
    }
    return copy as T;
  } catch { return payload; }
}

const RETRY_DELAYS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000];

export async function processFlowDeliveryQueue(limit = 20) {
  const attempts = await prisma.flowDeliveryAttempt.findMany({
    where: { status: "PENDING", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
    include: { submission: { include: { launch: { include: { flow: true, flowVersion: true, contact: true } } } } },
    take: limit,
    orderBy: { createdAt: "asc" },
  });
  for (const row of attempts) {
    const { submission } = row;
    const { flow, flowVersion, contact } = submission.launch;
    if (!flow.completionWebhookUrl || !flow.completionSecretEnc || !submission.responseEnc) {
      await prisma.flowDeliveryAttempt.update({ where: { id: row.id }, data: { status: "FAILED", error: "Webhook or response is unavailable." } });
      continue;
    }
    const payload = JSON.stringify({
      id: submission.id,
      type: "whatsapp.flow.completed",
      created_at: submission.completedAt.toISOString(),
      flow: { id: flow.id, name: flow.name, version: flowVersion.revision, meta_flow_id: flowVersion.metaFlowId },
      launch: { id: submission.launch.id },
      contact: { id: contact.id, wa_id: contact.waId },
      response: JSON.parse(decrypt(submission.responseEnc)),
    });
    const secret = decrypt(flow.completionSecretEnc);
    const signature = `sha256=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
    try {
      const response = await safePostJson(flow.completionWebhookUrl, [new URL(flow.completionWebhookUrl).hostname], { "Content-Type": "application/json", "X-Flow-Signature-256": signature, "X-Flow-Event-Id": submission.id }, payload, 10_000);
      if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(`Webhook returned HTTP ${response.status}.`), { responseStatus: response.status });
      await prisma.flowDeliveryAttempt.update({ where: { id: row.id }, data: { status: "DELIVERED", attempt: row.attempt + 1, responseStatus: response.status, deliveredAt: new Date(), error: null } });
    } catch (error) {
      const nextAttempt = row.attempt + 1;
      const exhausted = nextAttempt > RETRY_DELAYS.length;
      await prisma.flowDeliveryAttempt.update({
        where: { id: row.id },
        data: {
          attempt: nextAttempt,
          status: exhausted ? "FAILED" : "PENDING",
          nextAttemptAt: exhausted ? null : new Date(Date.now() + RETRY_DELAYS[nextAttempt - 1]),
          responseStatus: typeof error === "object" && error && "responseStatus" in error ? Number(error.responseStatus) : undefined,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}

export async function purgeExpiredFlowSubmissions() {
  const submissions = await prisma.flowSubmission.findMany({
    where: { responseEnc: { not: null } },
    include: { launch: { include: { flow: true } } },
    take: 500,
  });
  const expired = submissions.filter(({ completedAt, launch }) => completedAt.getTime() + launch.flow.retentionDays * 86_400_000 <= Date.now());
  if (!expired.length) return 0;
  await prisma.flowSubmission.updateMany({ where: { id: { in: expired.map((item) => item.id) } }, data: { responseEnc: null, purgedAt: new Date() } });
  return expired.length;
}

export async function runFlowMaintenance() {
  await processFlowDeliveryQueue();
  await purgeExpiredFlowSubmissions();
  await prisma.flowLaunch.updateMany({ where: { expiresAt: { lte: new Date() }, status: { in: ["PENDING", "SENT", "OPENED"] } }, data: { status: "EXPIRED" } });
}
