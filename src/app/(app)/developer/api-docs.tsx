"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { useI18n } from "@/components/i18n/language-provider";

type Method = "GET" | "POST";

type Endpoint = {
  method: Method;
  path: string;
  title: string;
  description: string;
  request?: string;
  response: string;
};

const METHOD_VARIANT: Record<Method, BadgeProps["variant"]> = {
  GET: "success",
  POST: "default",
};

function CodeBlock({ code }: { code: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative">
      <pre className="overflow-x-auto scroll-thin rounded-md bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-100 dark:bg-black/60">
        <code>{code}</code>
      </pre>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="absolute right-2 top-2 rounded-md bg-white/10 p-1.5 text-zinc-200 opacity-0 transition-opacity hover:bg-white/20 group-hover:opacity-100"
        title={t("apiDocs.copy")}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function EndpointCard({ ep }: { ep: Endpoint }) {
  const { t } = useI18n();
  return (
    <div className="rounded-lg border">
      <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <Badge variant={METHOD_VARIANT[ep.method]} className="font-mono">{ep.method}</Badge>
        <code className="text-xs font-medium">{ep.path}</code>
        <span className="ml-auto text-xs text-muted-foreground">{ep.title}</span>
      </div>
      <div className="space-y-3 p-3">
        <p className="text-xs text-muted-foreground">{ep.description}</p>
        {ep.request && (
          <div className="space-y-1">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("apiDocs.request")}</div>
            <CodeBlock code={ep.request} />
          </div>
        )}
        <div className="space-y-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("apiDocs.response")}</div>
          <CodeBlock code={ep.response} />
        </div>
      </div>
    </div>
  );
}

export function ApiDocs({ baseUrl }: { baseUrl: string }) {
  const KEY = "wba_live_your_api_key";
  const sent = `{
  "status": "success",
  "message_id": "wamid.HBgMOTE5...",
  "id": "clg1x...",
  "to": "919812345678"
}`;

  const readEndpoints: Endpoint[] = [
    {
      method: "GET",
      path: "/api/v1/status",
      title: "Connection status",
      description: "Check whether the WhatsApp account is connected.",
      request: `curl -s ${baseUrl}/api/v1/status \\
  -H "X-API-Key: ${KEY}"`,
      response: `{
  "status": "success",
  "data": {
    "connected": true,
    "phone_number": "+91 98765 43210",
    "business_name": "Acme Corp",
    "api_version": "v21.0"
  }
}`,
    },
    {
      method: "GET",
      path: "/api/v1/templates",
      title: "List templates",
      description: "List message templates. Filter by status with ?status=APPROVED.",
      request: `curl -s "${baseUrl}/api/v1/templates?status=APPROVED" \\
  -H "X-API-Key: ${KEY}"`,
      response: `{
  "status": "success",
  "data": [
    { "name": "order_update", "language": "en_US", "category": "UTILITY", "status": "APPROVED" }
  ]
}`,
    },
  ];

  const textMedia: Endpoint[] = [
    {
      method: "POST",
      path: "/api/v1/messages",
      title: "Text",
      description:
        "Free-form text. Allowed only within 24 h of the recipient's last inbound message — otherwise use a template.",
      request: `curl -s -X POST ${baseUrl}/api/v1/messages \\
  -H "X-API-Key: ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "919812345678",
    "type": "text",
    "text": "Hello from the API!"
  }'`,
      response: sent,
    },
    {
      method: "POST",
      path: "/api/v1/messages",
      title: "Image / video (by link)",
      description:
        "Send media by a publicly reachable URL (Meta downloads it). `type` is image, video, audio or document. `caption` is optional (not for audio).",
      request: `curl -s -X POST ${baseUrl}/api/v1/messages \\
  -H "X-API-Key: ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "919812345678",
    "type": "image",
    "media": {
      "link": "https://example.com/promo.jpg",
      "caption": "Our new collection"
    }
  }'`,
      response: sent,
    },
    {
      method: "POST",
      path: "/api/v1/messages",
      title: "Document / file (by link)",
      description:
        "For documents, add `filename` so the recipient sees a proper name. You can also pass `media.id` instead of `link` to reuse media already uploaded to Meta.",
      request: `curl -s -X POST ${baseUrl}/api/v1/messages \\
  -H "X-API-Key: ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "919812345678",
    "type": "document",
    "media": {
      "link": "https://example.com/invoice-A1234.pdf",
      "filename": "invoice-A1234.pdf",
      "caption": "Your invoice"
    }
  }'`,
      response: sent,
    },
  ];

  const templates: Endpoint[] = [
    {
      method: "POST",
      path: "/api/v1/messages",
      title: "Template — body variables",
      description:
        "Send an approved template (works any time). `body_variables` fills the body placeholders {{1}}, {{2}}… in order. (`variables` is an accepted alias.) For templates with named variables like {{code}}, pass an object instead, e.g. `{\"code\": \"1234\"}`. Omit them to use the template's saved sample values. Template footers are fixed at approval time and cannot receive send-time parameters.",
      request: `curl -s -X POST ${baseUrl}/api/v1/messages \\
  -H "X-API-Key: ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "919812345678",
    "type": "template",
    "template": "order_update",
    "language": "en_US",
    "body_variables": ["Priya", "#A1234"]
  }'`,
      response: sent,
    },
    {
      method: "POST",
      path: "/api/v1/messages",
      title: "Template — text header variable",
      description:
        "If the template's header is TEXT with a {{1}}, pass `header_text` to fill it.",
      request: `curl -s -X POST ${baseUrl}/api/v1/messages \\
  -H "X-API-Key: ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "919812345678",
    "type": "template",
    "template": "sale_alert",
    "language": "en_US",
    "header_text": "MEGA SALE",
    "body_variables": ["Priya", "50%"]
  }'`,
      response: sent,
    },
    {
      method: "POST",
      path: "/api/v1/messages",
      title: "Template — media header (image / video / file)",
      description:
        "If the template's header is IMAGE, VIDEO or DOCUMENT, pass `header_media` with a `link` (or a Meta `id`). For document headers include `filename`.",
      request: `curl -s -X POST ${baseUrl}/api/v1/messages \\
  -H "X-API-Key: ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "919812345678",
    "type": "template",
    "template": "order_confirmation",
    "language": "en_US",
    "header_media": {
      "type": "image",
      "link": "https://example.com/banner.jpg"
    },
    "body_variables": ["Priya", "#A1234"]
  }'`,
      response: sent,
    },
    {
      method: "POST",
      path: "/api/v1/messages",
      title: "Template — dynamic button",
      description:
        "Only buttons approved with a dynamic {{1}} accept URL parameters. Pass the button `index` (0-based) and either its replacement value or the complete URL matching the approved prefix. Static URL buttons are included automatically and must be omitted. `type` may also be quick_reply (payload) or copy_code (coupon).",
      request: `curl -s -X POST ${baseUrl}/api/v1/messages \\
  -H "X-API-Key: ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "919812345678",
    "type": "template",
    "template": "order_confirmation",
    "language": "en_US",
    "body_variables": ["Priya", "#A1234"],
    "buttons": [
      { "type": "url", "index": 0, "value": "https://example.com/order/A1234" }
    ]
  }'`,
      response: sent,
    },
    {
      method: "POST",
      path: "/api/v1/messages",
      title: "Template — raw components (advanced)",
      description:
        "For full control, pass Meta's native `components` array and it will be sent as-is (overrides all the shorthands above).",
      request: `curl -s -X POST ${baseUrl}/api/v1/messages \\
  -H "X-API-Key: ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "919812345678",
    "type": "template",
    "template": "order_confirmation",
    "language": "en_US",
    "components": [
      { "type": "header", "parameters": [{ "type": "image", "image": { "link": "https://example.com/b.jpg" } }] },
      { "type": "body", "parameters": [{ "type": "text", "text": "Priya" }] }
    ]
  }'`,
      response: sent,
    },
  ];

  const broadcast: Endpoint = {
    method: "POST",
    path: "/api/v1/broadcasts",
    title: "Start a broadcast",
    description:
      "Send an approved template to all contacts or those with a tag. Uses the template's saved sample values. Delivery status arrives via webhooks.",
    request: `curl -s -X POST ${baseUrl}/api/v1/broadcasts \\
  -H "X-API-Key: ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Diwali sale",
    "template": "promo_october",
    "audience": { "type": "tag", "tag": "vip" }
  }'`,
    response: `{
  "status": "success",
  "broadcast_id": "clg1x...",
  "total": 42
}`,
  };

  const flows: Endpoint[] = [
    {
      method: "GET",
      path: "/api/v1/flows",
      title: "List published Flows",
      description: "Returns Flow IDs that are ready to launch. Use next_cursor for pagination.",
      request: `curl -s ${baseUrl}/api/v1/flows \\
  -H "X-API-Key: ${KEY}"`,
      response: `{
  "status": "success",
  "data": [{ "id": "clx...", "name": "Lead form", "revision": 1, "meta_flow_id": "12345" }],
  "next_cursor": null
}`,
    },
    {
      method: "POST",
      path: "/api/v1/flows/{id}/launch",
      title: "Launch a Flow",
      description: "Sends a published Flow within the recipient's 24-hour service window. Initial data is encrypted at rest.",
      request: `curl -s -X POST ${baseUrl}/api/v1/flows/FLOW_ID/launch \\
  -H "X-API-Key: ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "919812345678",
    "cta": "Open form",
    "body": "Please complete your details",
    "entry_screen": "CONTACT",
    "data": { "customer_name": "Priya" }
  }'`,
      response: `{
  "status": "success",
  "launch_id": "clx...",
  "message_id": "wamid...",
  "conversation_id": "clx..."
}`,
    },
    {
      method: "GET",
      path: "/api/v1/flow-launches/{id}",
      title: "Get launch status",
      description: "Returns sent, opened, completed, failed, or expired state without exposing the Flow token.",
      response: `{ "status": "success", "launch": { "id": "clx...", "status": "completed", "submission_id": "clx..." } }`,
    },
    {
      method: "GET",
      path: "/api/v1/flow-submissions",
      title: "List submissions",
      description: "Returns completed responses. Filter with flow_id and paginate with cursor; fetch one by appending /{id}.",
      request: `curl -s "${baseUrl}/api/v1/flow-submissions?flow_id=FLOW_ID" \\
  -H "X-API-Key: ${KEY}"`,
      response: `{
  "status": "success",
  "data": [{ "id": "clx...", "response": { "name": "Priya" }, "completedAt": "2026-08-01T10:00:00.000Z" }]
}`,
    },
  ];

  const { t } = useI18n();

  return (
    <div className="max-w-3xl space-y-6">
      {/* Overview */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t("apiDocs.baseUrl")}</h2>
        <CodeBlock code={`${baseUrl}/api/v1`} />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t("apiDocs.authentication")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("apiDocs.auth.text")}
        </p>
        <CodeBlock code={`X-API-Key: ${KEY}`} />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t("apiDocs.keyRules")}</h2>
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li dangerouslySetInnerHTML={{ __html: t("apiDocs.keyRules.phones") }} />
          <li>{t("apiDocs.keyRules.window")}</li>
          <li dangerouslySetInnerHTML={{ __html: t("apiDocs.keyRules.media") }} />
        </ul>
      </section>

      {/* Read endpoints */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold">{t("apiDocs.accountTemplates")}</h2>
        {readEndpoints.map((ep, i) => <EndpointCard key={i} ep={ep} />)}
      </section>

      {/* Text & media */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold">{t("apiDocs.sendTextMedia")}</h2>
        {textMedia.map((ep, i) => <EndpointCard key={i} ep={ep} />)}
      </section>

      {/* Templates */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold">{t("apiDocs.sendTemplates")}</h2>
        <p className="text-xs text-muted-foreground">{t("apiDocs.templates.note")}</p>
        {templates.map((ep, i) => <EndpointCard key={i} ep={ep} />)}
      </section>

      {/* Broadcast */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold">{t("apiDocs.broadcast")}</h2>
        <EndpointCard ep={broadcast} />
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold">{t("apiDocs.flows")}</h2>
        <p className="text-xs text-muted-foreground">{t("apiDocs.flows.note")}</p>
        {flows.map((ep, i) => <EndpointCard key={i} ep={ep} />)}
      </section>

      {/* Errors */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t("apiDocs.errors")}</h2>
        <p className="text-xs text-muted-foreground">{t("apiDocs.errors.note")}</p>
        <CodeBlock code={`{
  "status": "error",
  "message": "Invalid or missing API key"
}`} />
      </section>
    </div>
  );
}
