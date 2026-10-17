"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Check, RefreshCw, RotateCcw, Send, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/use-toast";
import { useI18n } from "@/components/i18n/language-provider";

const EVENT_TYPES = [
  "inbound.message.received",
  "outbound.message.accepted",
  "outbound.message.status_changed",
  "conversation.changed",
] as const;

type Destination = {
  id: string;
  name: string;
  endpointUrl: string;
  enabled: boolean;
  retiredAt: string | null;
  subscriptions: string[];
  secretVersion: number;
  lastTestAt: string | null;
};

type HistoryRow = {
  id: string;
  eventId: string;
  state: string;
  attemptCount: number;
  lastError: string | null;
  event: { eventType: string };
};

type FormState = { name: string; endpointUrl: string; subscriptions: string[] };

const emptyForm: FormState = { name: "", endpointUrl: "https://", subscriptions: ["inbound.message.received"] };

export function WebhookDestinationsClient({ tenantId }: { tenantId: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [secret, setSecret] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"config" | "docs">("config");

  const destinations = useQuery({
    queryKey: ["webhook-destinations", tenantId],
    queryFn: () => apiFetch<{ destinations: Destination[] }>(`/api/tenants/${tenantId}/webhook-destinations`),
  });
  const history = useQuery({
    queryKey: ["webhook-destination-history", tenantId, historyFor],
    queryFn: () => apiFetch<{ history: HistoryRow[] }>(`/api/tenants/${tenantId}/webhook-destinations/${historyFor}/history`),
    enabled: Boolean(historyFor),
  });

  const create = useMutation({
    mutationFn: () => apiFetch<{ destination: Destination; signingSecret: string }>(`/api/tenants/${tenantId}/webhook-destinations`, { method: "POST", body: JSON.stringify(form) }),
    onSuccess: (data) => {
      setSecret(data.signingSecret);
      setForm(emptyForm);
      qc.invalidateQueries({ queryKey: ["webhook-destinations", tenantId] });
      toast({ title: t("webhooks.createdToast"), description: t("webhooks.createdToastDescription") });
    },
    onError: (e) => toast({ title: t("webhooks.errorCreate"), description: e instanceof Error ? e.message : t("webhooks.errorUnknown"), variant: "destructive" }),
  });

  const action = useMutation({
    mutationFn: ({ id, path }: { id: string; path: string }) => apiFetch(`/api/tenants/${tenantId}/webhook-destinations/${id}/${path}`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["webhook-destinations", tenantId] }),
    onError: (e) => toast({ title: t("webhooks.errorAction"), description: e instanceof Error ? e.message : t("webhooks.errorUnknown"), variant: "destructive" }),
  });

  const retire = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/tenants/${tenantId}/webhook-destinations/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["webhook-destinations", tenantId] }),
  });

  const rotate = useMutation({
    mutationFn: (id: string) => apiFetch<{ signingSecret: string }>(`/api/tenants/${tenantId}/webhook-destinations/${id}/rotate-secret`, { method: "POST" }),
    onSuccess: (data) => setSecret(data.signingSecret),
  });

  function toggleSubscription(eventType: string) {
    setForm((current) => ({
      ...current,
      subscriptions: current.subscriptions.includes(eventType)
        ? current.subscriptions.filter((item) => item !== eventType)
        : [...current.subscriptions, eventType],
    }));
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <PageHeader title={t("webhooks.title")} description={t("webhooks.pageDescription")} />
      <div className="border-b bg-card px-4 py-2 sm:px-6">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "config" | "docs")}>
          <TabsList className="h-10 gap-1 bg-transparent p-0 sm:justify-start">
            <TabsTrigger
              value="config"
              className="h-10 rounded-lg border border-transparent px-4 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground data-[state=active]:border-primary/20 data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none"
            >
              {t("webhooks.tabConfig")}
            </TabsTrigger>
            <TabsTrigger
              value="docs"
              className="h-10 rounded-lg border border-transparent px-4 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground data-[state=active]:border-primary/20 data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none"
            >
              {t("webhooks.tabDocs")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="space-y-4 p-4 sm:p-6">
      {activeTab === "docs" && <WebhookDocs />}

      {activeTab === "config" && (
      <>
      {secret && (
        <Card className="border-amber-300 bg-amber-50">
          <CardHeader><CardTitle>{t("webhooks.secretVisibleOnce")}</CardTitle></CardHeader>
          <CardContent><code className="break-all text-sm">{secret}</code></CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t("webhooks.newDestination")}</CardTitle>
          <CardDescription>{t("webhooks.newDestinationDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div><Label>{t("webhooks.labelName")}</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><Label>{t("webhooks.labelUrl")}</Label><Input value={form.endpointUrl} onChange={(e) => setForm({ ...form, endpointUrl: e.target.value })} /></div>
          </div>
          <div className="space-y-2">
            <Label>{t("webhooks.labelSubscriptions")}</Label>
            <div className="grid gap-2 md:grid-cols-2">
              {EVENT_TYPES.map((eventType) => (
                <label key={eventType} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                  <input type="checkbox" checked={form.subscriptions.includes(eventType)} onChange={() => toggleSubscription(eventType)} />
                  {eventType}
                </label>
              ))}
            </div>
          </div>
          <Button onClick={() => create.mutate()} disabled={create.isPending || form.subscriptions.length === 0}>{t("webhooks.buttonCreate")}</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("webhooks.destinations")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {destinations.isLoading && <p>{t("users.loading")}</p>}
          {destinations.data?.destinations.map((destination) => (
            <div key={destination.id} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2"><h3 className="font-semibold">{destination.name}</h3><Badge>{destination.retiredAt ? t("webhooks.statusRetired") : destination.enabled ? t("webhooks.statusActive") : t("webhooks.statusDisabled")}</Badge></div>
                  <p className="break-all text-sm text-muted-foreground">{destination.endpointUrl}</p>
                  <p className="text-xs text-muted-foreground">{t("webhooks.stableId")}: {destination.id} · {t("webhooks.secretoVersion")}{destination.secretVersion}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => action.mutate({ id: destination.id, path: destination.enabled ? "disable" : "enable" })} disabled={Boolean(destination.retiredAt)}>{destination.enabled ? t("webhooks.buttonDisable") : t("webhooks.buttonEnable")}</Button>
                  <Button size="sm" variant="outline" onClick={() => rotate.mutate(destination.id)} disabled={Boolean(destination.retiredAt)}><RotateCcw className="mr-1 h-4 w-4" />{t("webhooks.buttonRotate")}</Button>
                  <Button size="sm" variant="outline" onClick={() => action.mutate({ id: destination.id, path: "test" })} disabled={!destination.enabled || Boolean(destination.retiredAt)}><Send className="mr-1 h-4 w-4" />{t("webhooks.buttonTest")}</Button>
                  <Button size="sm" variant="outline" onClick={() => setHistoryFor(destination.id)}><RefreshCw className="mr-1 h-4 w-4" />{t("webhooks.buttonHistory")}</Button>
                  <Button size="sm" variant="destructive" onClick={() => retire.mutate(destination.id)} disabled={Boolean(destination.retiredAt)}><Trash2 className="mr-1 h-4 w-4" />{t("webhooks.buttonRetire")}</Button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">{destination.subscriptions.map((item) => <Badge key={item} variant="outline">{item}</Badge>)}</div>
            </div>
          ))}
        </CardContent>
      </Card>

      {historyFor && (
        <Card>
          <CardHeader><CardTitle>{t("webhooks.deliveryHistory")}</CardTitle><CardDescription>{t("webhooks.deliveryHistoryDescription")}</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            {history.data?.history.length === 0 && <p className="text-sm text-muted-foreground">{t("webhooks.noDeliveries")}</p>}
            {history.data?.history.map((row) => (
              <div key={row.id} className="rounded-md border p-3 text-sm">
                <div className="font-medium">{row.event.eventType} · {row.state}</div>
                <div className="text-muted-foreground">{row.eventId} · {t("webhooks.attempts")}: {row.attemptCount}{row.lastError ? ` · ${row.lastError}` : ""}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      </>)}
      </div>
    </div>
  );
}

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
        title={t("webhooks.copyToClipboard")}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function FieldTable({ fields }: { fields: { field: string; type: string; required: boolean; description: string }[] }) {
  const { t } = useI18n();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b">
            <th className="pr-4 text-left font-medium">{t("webhooks.fieldTableCampo")}</th>
            <th className="pr-4 text-left font-medium">{t("webhooks.fieldTableTipo")}</th>
            <th className="pr-4 text-left font-medium">{t("webhooks.fieldTableOblig")}</th>
            <th className="text-left font-medium">{t("webhooks.fieldTableDescripcion")}</th>
          </tr>
        </thead>
        <tbody className="text-muted-foreground">
          {fields.map((f) => (
            <tr key={f.field} className="border-b last:border-0">
              <td className="pr-4 font-mono text-foreground">{f.field}</td>
              <td className="pr-4"><Badge variant="outline" className="font-mono text-[10px]">{f.type}</Badge></td>
              <td className="pr-4">{f.required ? <span className="text-foreground">{t("webhooks.fieldTableSi")}</span> : t("webhooks.fieldTableNo")}</td>
              <td>{f.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EventCard({
  eventType,
  title,
  description,
  when,
  useCases,
  envelopeFields,
  payloadFields,
  example,
  notes,
}: {
  eventType: string;
  title: string;
  description: string;
  when: string;
  useCases: string[];
  envelopeFields: { field: string; type: string; required: boolean; description: string }[];
  payloadFields: { field: string; type: string; required: boolean; description: string }[];
  example: string;
  notes?: string[];
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors"
      >
        <Badge variant="outline" className="font-mono shrink-0">{eventType}</Badge>
        <span className="font-medium">{title}</span>
        <span className="ml-auto text-xs text-muted-foreground">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div className="space-y-4 border-t px-4 pb-4 pt-3">
          <p className="text-xs text-muted-foreground">{description}</p>

          <div className="space-y-1">
            <h4 className="text-xs font-semibold">{t("webhooks.sectionWhen")}</h4>
            <p className="text-xs text-muted-foreground">{when}</p>
          </div>

          <div className="space-y-1">
            <h4 className="text-xs font-semibold">{t("webhooks.sectionUseCases")}</h4>
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
              {useCases.map((uc, i) => <li key={i}>{uc}</li>)}
            </ul>
          </div>

          <div className="space-y-1">
            <h4 className="text-xs font-semibold">{t("webhooks.sectionEnvelope")}</h4>
            <FieldTable fields={envelopeFields} />
          </div>

          <div className="space-y-1">
            <h4 className="text-xs font-semibold">{t("webhooks.sectionPayload")}</h4>
            <FieldTable fields={payloadFields} />
          </div>

          <div className="space-y-1">
            <h4 className="text-xs font-semibold">{t("webhooks.sectionExample")}</h4>
            <CodeBlock code={example} />
          </div>

          {notes && notes.length > 0 && (
            <div className="space-y-1">
              <h4 className="text-xs font-semibold">{t("webhooks.sectionNotes")}</h4>
              <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                {notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function WebhookDocs() {
  const { t } = useI18n();
  const envelopeFields = [
    { field: "id", type: "string", required: true, description: t("webhooks.docs.f.env.id") },
    { field: "type", type: "string", required: true, description: t("webhooks.docs.f.env.type") },
    { field: "version", type: "number", required: true, description: t("webhooks.docs.f.env.version") },
    { field: "tenantId", type: "string", required: true, description: t("webhooks.docs.f.env.tenantId") },
    { field: "occurredAt", type: "string (ISO 8601)", required: true, description: t("webhooks.docs.f.env.occurredAt") },
    { field: "recordedAt", type: "string (ISO 8601)", required: true, description: t("webhooks.docs.f.env.recordedAt") },
    { field: "entities", type: "array", required: true, description: t("webhooks.docs.f.env.entities") },
    { field: "meta.producer", type: "string", required: true, description: t("webhooks.docs.f.env.metaProducer") },
    { field: "meta.correlationId", type: "string?", required: false, description: t("webhooks.docs.f.env.metaCorrelationId") },
    { field: "payload", type: "object", required: true, description: t("webhooks.docs.f.env.payload") },
  ];

  const inboundEnvelopeFields = envelopeFields;

  const inboundPayloadFields = [
    { field: "conversationId", type: "string", required: true, description: t("webhooks.docs.f.conversationId") },
    { field: "messageId", type: "string", required: true, description: t("webhooks.docs.f.messageId") },
    { field: "contactId", type: "string", required: true, description: t("webhooks.docs.f.inb.contactId") },
    { field: "phoneNumberId", type: "string", required: true, description: t("webhooks.docs.f.inb.phoneNumberId") },
    { field: "wabaAccountId", type: "string", required: true, description: t("webhooks.docs.f.wabaAccountId") },
    { field: "type", type: "string", required: true, description: t("webhooks.docs.f.inb.type") },
    { field: "receivedAt", type: "string (ISO 8601)", required: true, description: t("webhooks.docs.f.inb.receivedAt") },
    { field: "providerMessageId", type: "string?", required: false, description: t("webhooks.docs.f.inb.providerMessageId") },
    { field: "preview", type: "string?", required: false, description: t("webhooks.docs.f.inb.preview") },
  ];

  const outboundAcceptedPayloadFields = [
    { field: "conversationId", type: "string", required: true, description: t("webhooks.docs.f.conversationId") },
    { field: "messageId", type: "string", required: true, description: t("webhooks.docs.f.messageId") },
    { field: "contactId", type: "string", required: true, description: t("webhooks.docs.f.acc.contactId") },
    { field: "phoneNumberId", type: "string", required: true, description: t("webhooks.docs.f.acc.phoneNumberId") },
    { field: "wabaAccountId", type: "string", required: true, description: t("webhooks.docs.f.wabaAccountId") },
    { field: "type", type: "string", required: true, description: t("webhooks.docs.f.acc.type") },
    { field: "acceptedAt", type: "string (ISO 8601)", required: true, description: t("webhooks.docs.f.acc.acceptedAt") },
    { field: "providerMessageId", type: "string?", required: false, description: t("webhooks.docs.f.acc.providerMessageId") },
  ];

  const outboundStatusPayloadFields = [
    { field: "conversationId", type: "string", required: true, description: t("webhooks.docs.f.cv.conversationId") },
    { field: "messageId", type: "string", required: true, description: t("webhooks.docs.f.messageId") },
    { field: "phoneNumberId", type: "string", required: true, description: t("webhooks.docs.f.st.phoneNumberId") },
    { field: "wabaAccountId", type: "string", required: true, description: t("webhooks.docs.f.wabaAccountId") },
    { field: "previousStatus", type: "string | null", required: true, description: t("webhooks.docs.f.st.previousStatus") },
    { field: "status", type: "string", required: true, description: t("webhooks.docs.f.st.status") },
    { field: "changedAt", type: "string (ISO 8601)", required: true, description: t("webhooks.docs.f.st.changedAt") },
    { field: "providerMessageId", type: "string?", required: false, description: t("webhooks.docs.f.st.providerMessageId") },
  ];

  const conversationPayloadFields = [
    { field: "conversationId", type: "string", required: true, description: t("webhooks.docs.f.cv.conversationId") },
    { field: "contactId", type: "string", required: true, description: t("webhooks.docs.f.cv.contactId") },
    { field: "phoneNumberId", type: "string | null", required: true, description: t("webhooks.docs.f.cv.phoneNumberId") },
    { field: "wabaAccountId", type: "string | null", required: true, description: t("webhooks.docs.f.cv.wabaAccountId") },
    { field: "kind", type: "string", required: true, description: t("webhooks.docs.f.cv.kind") },
    { field: "status", type: "string | null", required: true, description: t("webhooks.docs.f.cv.status") },
    { field: "occurredAt", type: "string (ISO 8601)", required: true, description: t("webhooks.docs.f.cv.occurredAt") },
  ];

  return (
    <div className="max-w-3xl space-y-6">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t("webhooks.docs.intro.title")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("webhooks.docs.intro.p1")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("webhooks.docs.intro.p2")}
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t("webhooks.docs.delivery.title")}</h2>
        <div className="space-y-2">
          <div className="grid grid-cols-[120px_1fr] gap-1 text-xs">
            <span className="font-medium text-muted-foreground">{t("webhooks.docs.delivery.method")}</span>
            <span>{t("webhooks.docs.delivery.methodValue")}</span>
            <span className="font-medium text-muted-foreground">{t("webhooks.docs.delivery.auth")}</span>
            <span>{t("webhooks.docs.delivery.authValue")}</span>
            <span className="font-medium text-muted-foreground">{t("webhooks.docs.delivery.headers")}</span>
            <span>{t("webhooks.docs.delivery.headersValue")}</span>
            <span className="font-medium text-muted-foreground">{t("webhooks.docs.delivery.timeout")}</span>
            <span>{t("webhooks.docs.delivery.timeoutValue")}</span>
            <span className="font-medium text-muted-foreground">{t("webhooks.docs.delivery.retries")}</span>
            <span>{t("webhooks.docs.delivery.retriesValue")}</span>
            <span className="font-medium text-muted-foreground">{t("webhooks.docs.delivery.responses")}</span>
            <span>{t("webhooks.docs.delivery.responsesValue")}</span>
            <span className="font-medium text-muted-foreground">{t("webhooks.docs.delivery.idempotency")}</span>
            <span>{t("webhooks.docs.delivery.idempotencyValue")}</span>
            <span className="font-medium text-muted-foreground">{t("webhooks.docs.delivery.order")}</span>
            <span>{t("webhooks.docs.delivery.orderValue")}</span>
            <span className="font-medium text-muted-foreground">{t("webhooks.docs.delivery.urls")}</span>
            <span>{t("webhooks.docs.delivery.urlsValue")}</span>
            <span className="font-medium text-muted-foreground">{t("webhooks.docs.delivery.security")}</span>
            <span>{t("webhooks.docs.delivery.securityValue")}</span>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t("webhooks.docs.envelope.title")}</h2>
        <p className="text-xs text-muted-foreground">{t("webhooks.docs.envelope.description")}</p>
        <FieldTable fields={inboundEnvelopeFields} />
        <CodeBlock code={`{
  "id": "evt:inbound.message.received:tenant_abc:msg_xyz",
  "type": "inbound.message.received",
  "version": 1,
  "tenantId": "tenant_abc",
  "occurredAt": "2026-01-15T10:30:00.000Z",
  "recordedAt": "2026-01-15T10:30:00.123Z",
  "entities": [
    { "kind": "tenant", "id": "tenant_abc" },
    { "kind": "waba", "id": "waba_123" },
    { "kind": "phone", "id": "phone_456" },
    { "kind": "conversation", "id": "conv_789" },
    { "kind": "message", "id": "msg_xyz" },
    { "kind": "contact", "id": "contact_abc" }
  ],
  "meta": { "producer": "whatsapp-business-admin" },
  "payload": { ... }
}`} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t("webhooks.docs.eventTypes.title")}</h2>
        <p className="text-xs text-muted-foreground">{t("webhooks.docs.eventTypes.description")}</p>

        <EventCard
          eventType="inbound.message.received"
          title={t("webhooks.docs.evt.inbound.title")}
          description={t("webhooks.docs.evt.inbound.description")}
          when={t("webhooks.docs.evt.inbound.when")}
          useCases={[
            t("webhooks.docs.evt.inbound.uc1"),
            t("webhooks.docs.evt.inbound.uc2"),
            t("webhooks.docs.evt.inbound.uc3"),
            t("webhooks.docs.evt.inbound.uc4"),
          ]}
          envelopeFields={inboundEnvelopeFields}
          payloadFields={inboundPayloadFields}
          example={`{
  "id": "evt:inbound.message.received:tenant_abc:msg_xyz",
  "type": "inbound.message.received",
  "version": 1,
  "tenantId": "tenant_abc",
  "occurredAt": "2026-01-15T10:30:00.000Z",
  "recordedAt": "2026-01-15T10:30:00.050Z",
  "entities": [
    { "kind": "tenant", "id": "tenant_abc" },
    { "kind": "waba", "id": "waba_123" },
    { "kind": "phone", "id": "phone_456" },
    { "kind": "conversation", "id": "conv_789" },
    { "kind": "message", "id": "msg_xyz" },
    { "kind": "contact", "id": "contact_abc" }
  ],
  "meta": { "producer": "whatsapp-business-admin" },
  "payload": {
    "conversationId": "conv_789",
    "messageId": "msg_xyz",
    "contactId": "contact_abc",
    "phoneNumberId": "phone_456",
    "wabaAccountId": "waba_123",
    "type": "TEXT",
    "receivedAt": "2026-01-15T10:30:00.000Z",
    "providerMessageId": "wamid.HBgMOTE5...",
    "preview": "Hola, quiero información sobre..."
  }
}`}
          notes={[
            t("webhooks.docs.evt.inbound.note1"),
            t("webhooks.docs.evt.inbound.note2"),
            t("webhooks.docs.evt.inbound.note3"),
          ]}
        />

        <EventCard
          eventType="outbound.message.accepted"
          title={t("webhooks.docs.evt.accepted.title")}
          description={t("webhooks.docs.evt.accepted.description")}
          when={t("webhooks.docs.evt.accepted.when")}
          useCases={[
            t("webhooks.docs.evt.accepted.uc1"),
            t("webhooks.docs.evt.accepted.uc2"),
            t("webhooks.docs.evt.accepted.uc3"),
          ]}
          envelopeFields={inboundEnvelopeFields}
          payloadFields={outboundAcceptedPayloadFields}
          example={`{
  "id": "evt:outbound.message.accepted:tenant_abc:msg_xyz",
  "type": "outbound.message.accepted",
  "version": 1,
  "tenantId": "tenant_abc",
  "occurredAt": "2026-01-15T10:31:00.000Z",
  "recordedAt": "2026-01-15T10:31:00.050Z",
  "entities": [
    { "kind": "tenant", "id": "tenant_abc" },
    { "kind": "waba", "id": "waba_123" },
    { "kind": "phone", "id": "phone_456" },
    { "kind": "conversation", "id": "conv_789" },
    { "kind": "message", "id": "msg_xyz" },
    { "kind": "contact", "id": "contact_abc" }
  ],
  "meta": { "producer": "whatsapp-business-admin" },
  "payload": {
    "conversationId": "conv_789",
    "messageId": "msg_xyz",
    "contactId": "contact_abc",
    "phoneNumberId": "phone_456",
    "wabaAccountId": "waba_123",
    "type": "TEXT",
    "acceptedAt": "2026-01-15T10:31:00.000Z",
    "providerMessageId": "wamid.HBgMOTE5..."
  }
}`}
          notes={[
            t("webhooks.docs.evt.accepted.note1"),
            t("webhooks.docs.evt.accepted.note2"),
          ]}
        />

        <EventCard
          eventType="outbound.message.status_changed"
          title={t("webhooks.docs.evt.statusChanged.title")}
          description={t("webhooks.docs.evt.statusChanged.description")}
          when={t("webhooks.docs.evt.statusChanged.when")}
          useCases={[
            t("webhooks.docs.evt.statusChanged.uc1"),
            t("webhooks.docs.evt.statusChanged.uc2"),
            t("webhooks.docs.evt.statusChanged.uc3"),
            t("webhooks.docs.evt.statusChanged.uc4"),
          ]}
          envelopeFields={inboundEnvelopeFields}
          payloadFields={outboundStatusPayloadFields}
          example={`{
  "id": "evt:outbound.message.status_changed:tenant_abc:msg_xyz:PENDING:SENT",
  "type": "outbound.message.status_changed",
  "version": 1,
  "tenantId": "tenant_abc",
  "occurredAt": "2026-01-15T10:31:05.000Z",
  "recordedAt": "2026-01-15T10:31:05.050Z",
  "entities": [
    { "kind": "tenant", "id": "tenant_abc" },
    { "kind": "waba", "id": "waba_123" },
    { "kind": "phone", "id": "phone_456" },
    { "kind": "conversation", "id": "conv_789" },
    { "kind": "message", "id": "msg_xyz" }
  ],
  "meta": { "producer": "whatsapp-business-admin" },
  "payload": {
    "conversationId": "conv_789",
    "messageId": "msg_xyz",
    "phoneNumberId": "phone_456",
    "wabaAccountId": "waba_123",
    "previousStatus": "PENDING",
    "status": "SENT",
    "changedAt": "2026-01-15T10:31:05.000Z",
    "providerMessageId": "wamid.HBgMOTE5..."
  }
}`}
          notes={[
            t("webhooks.docs.evt.statusChanged.note1"),
            t("webhooks.docs.evt.statusChanged.note2"),
            t("webhooks.docs.evt.statusChanged.note3"),
            t("webhooks.docs.evt.statusChanged.note4"),
          ]}
        />

        <EventCard
          eventType="conversation.changed"
          title={t("webhooks.docs.evt.conversation.title")}
          description={t("webhooks.docs.evt.conversation.description")}
          when={t("webhooks.docs.evt.conversation.when")}
          useCases={[
            t("webhooks.docs.evt.conversation.uc1"),
            t("webhooks.docs.evt.conversation.uc2"),
            t("webhooks.docs.evt.conversation.uc3"),
            t("webhooks.docs.evt.conversation.uc4"),
          ]}
          envelopeFields={inboundEnvelopeFields}
          payloadFields={conversationPayloadFields}
          example={`{
  "id": "evt:conversation.changed:tenant_abc:conv_xyz:CREATED:OPEN",
  "type": "conversation.changed",
  "version": 1,
  "tenantId": "tenant_abc",
  "occurredAt": "2026-01-15T10:30:00.000Z",
  "recordedAt": "2026-01-15T10:30:00.050Z",
  "entities": [
    { "kind": "tenant", "id": "tenant_abc" },
    { "kind": "waba", "id": "waba_123" },
    { "kind": "phone", "id": "phone_456" },
    { "kind": "conversation", "id": "conv_xyz" },
    { "kind": "contact", "id": "contact_abc" }
  ],
  "meta": { "producer": "whatsapp-business-admin" },
  "payload": {
    "conversationId": "conv_xyz",
    "contactId": "contact_abc",
    "phoneNumberId": "phone_456",
    "wabaAccountId": "waba_123",
    "kind": "CREATED",
    "status": "OPEN",
    "occurredAt": "2026-01-15T10:30:00.000Z"
  }
}`}
          notes={[
            t("webhooks.docs.evt.conversation.note1"),
            t("webhooks.docs.evt.conversation.note2"),
            t("webhooks.docs.evt.conversation.note3"),
          ]}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t("webhooks.docs.signature.title")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("webhooks.docs.signature.p1")}
        </p>
        <CodeBlock code={`import crypto from "crypto";

function verify(body, timestampHeader, signatureHeader, secret) {
  const timestamp = Number(timestampHeader);
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return false;
  const payload = Buffer.from(timestamp + "." + body);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const actual = signatureHeader.replace("v1=", "");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}`} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t("webhooks.docs.conventions.title")}</h2>
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>{t("webhooks.docs.conventions.stableIds")}</li>
          <li>{t("webhooks.docs.conventions.deduplication")}</li>
          <li>{t("webhooks.docs.conventions.occurrence")}</li>
          <li>{t("webhooks.docs.conventions.noSecrets")}</li>
          <li>{t("webhooks.docs.conventions.phone")}</li>
        </ul>
      </section>
    </div>
  );
}
