type WebhookValue = {
  messages?: { interactive?: { nfm_reply?: unknown } }[];
  statuses?: unknown[];
  event?: unknown;
};

export type WebhookEventKind = "inbound-message" | "status" | "template-status" | "flow-reply" | "unsupported";

export interface WebhookClassification {
  kinds: WebhookEventKind[];
  hasInboundMessages: boolean;
  hasStatuses: boolean;
  hasTemplateStatuses: boolean;
  hasFlowReplies: boolean;
}

export function classifyWebhookPayload(payload: unknown): WebhookClassification {
  const root = payload as { entry?: { changes?: { field?: string; value?: WebhookValue }[] }[] };
  const kinds = new Set<WebhookEventKind>();

  for (const entry of root.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;

      if (change.field === "message_template_status_update" || value.event) kinds.add("template-status");
      if ((value.messages?.length ?? 0) > 0) kinds.add("inbound-message");
      if (value.messages?.some((message) => message.interactive?.nfm_reply)) kinds.add("flow-reply");
      if ((value.statuses?.length ?? 0) > 0) kinds.add("status");
      if (!value.event && !value.messages?.length && !value.statuses?.length) kinds.add("unsupported");
    }
  }

  return {
    kinds: [...kinds],
    hasInboundMessages: kinds.has("inbound-message"),
    hasStatuses: kinds.has("status"),
    hasTemplateStatuses: kinds.has("template-status"),
    hasFlowReplies: kinds.has("flow-reply"),
  };
}
