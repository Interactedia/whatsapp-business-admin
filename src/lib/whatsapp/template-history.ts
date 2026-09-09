import { prisma } from "@/lib/prisma";
import { asRecord, buildTemplateContent, readTemplateContent, type TemplateContent } from "./template-content";

type HistoricalMessage = { id: string; type: string; templateId: string | null; payload: unknown; text: string | null; waMessageId: string | null };

/** Batch reconstruction for old messages; reads never rewrite message history. */
export async function resolveTemplateContents(messages: HistoricalMessage[]): Promise<Map<string, TemplateContent>> {
  const result = new Map<string, TemplateContent>();
  const historical = messages.filter((message) => {
    if (message.type !== "TEMPLATE") return false;
    const snapshot = readTemplateContent(message.payload);
    if (snapshot) result.set(message.id, snapshot);
    return !snapshot;
  });
  if (!historical.length) return result;

  const [templates, logs] = await Promise.all([
    prisma.template.findMany({ where: { id: { in: historical.flatMap((m) => m.templateId ? [m.templateId] : []) } } }),
    prisma.apiLog.findMany({
      where: { relatedType: "message", relatedId: { in: historical.map((m) => m.id) }, method: "POST" },
      select: { relatedId: true, requestBody: true, responseBody: true, ok: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const byId = new Map(templates.map((t) => [t.id, t]));
  const requests = new Map<string, Record<string, unknown>>();
  for (const message of historical) {
    const candidates = logs.filter((log) => log.relatedId === message.id && asRecord(log.requestBody).type === "template");
    const match = candidates.find((log) => {
      const sent = asRecord(log.responseBody).messages;
      return message.waMessageId && Array.isArray(sent) && sent.some((m) => asRecord(m).id === message.waMessageId);
    }) ?? candidates.find((log) => log.ok) ?? candidates[0];
    requests.set(message.id, asRecord(asRecord(match?.requestBody).template));
  }
  // A template relation can be lost after deletion; resolve only an exact name/language match.
  const identities = historical.flatMap((m) => {
    const request = requests.get(m.id)!;
    const language = asRecord(request.language).code;
    return !byId.has(m.templateId ?? "") && typeof request.name === "string" && typeof language === "string"
      ? [{ name: request.name, language }] : [];
  });
  const byIdentity = identities.length ? await prisma.template.findMany({ where: { OR: identities } }) : [];

  for (const message of historical) {
    const request = requests.get(message.id)!;
    const language = asRecord(request.language).code;
    const template = byId.get(message.templateId ?? "") ?? byIdentity.find((t) => t.name === request.name && t.language === language);
    result.set(message.id, buildTemplateContent({
      name: template?.name ?? (typeof request.name === "string" ? request.name : message.text?.replace(/^Template:\s*/, "") || "Unknown template"),
      language: template?.language ?? (typeof language === "string" ? language : ""),
      definition: template?.components,
      parameters: request.components,
      source: "reconstructed",
    }));
  }
  return result;
}
