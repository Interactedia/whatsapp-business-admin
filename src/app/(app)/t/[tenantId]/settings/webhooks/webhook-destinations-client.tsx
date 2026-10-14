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
import { useToast } from "@/components/ui/use-toast";

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
      toast({ title: "Webhook creado", description: "Copia el secreto ahora; no se volverá a mostrar." });
    },
    onError: (e) => toast({ title: "No se pudo crear", description: e instanceof Error ? e.message : "Error desconocido", variant: "destructive" }),
  });

  const action = useMutation({
    mutationFn: ({ id, path }: { id: string; path: string }) => apiFetch(`/api/tenants/${tenantId}/webhook-destinations/${id}/${path}`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["webhook-destinations", tenantId] }),
    onError: (e) => toast({ title: "Acción fallida", description: e instanceof Error ? e.message : "Error desconocido", variant: "destructive" }),
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
    <div className="space-y-6">
      <div className="flex gap-1 border-b">
        <button
          onClick={() => setActiveTab("config")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${activeTab === "config" ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          Configuración
        </button>
        <button
          onClick={() => setActiveTab("docs")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${activeTab === "docs" ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          Documentación
        </button>
      </div>

      {activeTab === "docs" && <WebhookDocs />}

      {activeTab === "config" && (
      <>
      <PageHeader title="Webhooks salientes" description="Configuración tenant-scoped para consumidores HTTP externos." />
      {secret && (
        <Card className="border-amber-300 bg-amber-50">
          <CardHeader><CardTitle>Secreto visible una sola vez</CardTitle></CardHeader>
          <CardContent><code className="break-all text-sm">{secret}</code></CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Nuevo destino</CardTitle>
          <CardDescription>Solo HTTPS. Las IP privadas, loopback y redirecciones se vuelven a validar al entregar.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div><Label>Nombre</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><Label>URL HTTPS</Label><Input value={form.endpointUrl} onChange={(e) => setForm({ ...form, endpointUrl: e.target.value })} /></div>
          </div>
          <div className="space-y-2">
            <Label>Suscripciones</Label>
            <div className="grid gap-2 md:grid-cols-2">
              {EVENT_TYPES.map((eventType) => (
                <label key={eventType} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                  <input type="checkbox" checked={form.subscriptions.includes(eventType)} onChange={() => toggleSubscription(eventType)} />
                  {eventType}
                </label>
              ))}
            </div>
          </div>
          <Button onClick={() => create.mutate()} disabled={create.isPending || form.subscriptions.length === 0}>Crear destino</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Destinos</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {destinations.isLoading && <p>Cargando…</p>}
          {destinations.data?.destinations.map((destination) => (
            <div key={destination.id} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2"><h3 className="font-semibold">{destination.name}</h3><Badge>{destination.retiredAt ? "retirado" : destination.enabled ? "activo" : "deshabilitado"}</Badge></div>
                  <p className="break-all text-sm text-muted-foreground">{destination.endpointUrl}</p>
                  <p className="text-xs text-muted-foreground">ID estable: {destination.id} · secreto v{destination.secretVersion}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => action.mutate({ id: destination.id, path: destination.enabled ? "disable" : "enable" })} disabled={Boolean(destination.retiredAt)}>{destination.enabled ? "Deshabilitar" : "Habilitar"}</Button>
                  <Button size="sm" variant="outline" onClick={() => rotate.mutate(destination.id)} disabled={Boolean(destination.retiredAt)}><RotateCcw className="mr-1 h-4 w-4" />Rotar</Button>
                  <Button size="sm" variant="outline" onClick={() => action.mutate({ id: destination.id, path: "test" })} disabled={!destination.enabled || Boolean(destination.retiredAt)}><Send className="mr-1 h-4 w-4" />Probar</Button>
                  <Button size="sm" variant="outline" onClick={() => setHistoryFor(destination.id)}><RefreshCw className="mr-1 h-4 w-4" />Historial</Button>
                  <Button size="sm" variant="destructive" onClick={() => retire.mutate(destination.id)} disabled={Boolean(destination.retiredAt)}><Trash2 className="mr-1 h-4 w-4" />Retirar</Button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">{destination.subscriptions.map((item) => <Badge key={item} variant="outline">{item}</Badge>)}</div>
            </div>
          ))}
        </CardContent>
      </Card>

      {historyFor && (
        <Card>
          <CardHeader><CardTitle>Historial de entrega</CardTitle><CardDescription>Sin cuerpos ni secretos.</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            {history.data?.history.length === 0 && <p className="text-sm text-muted-foreground">Sin entregas registradas.</p>}
            {history.data?.history.map((row) => (
              <div key={row.id} className="rounded-md border p-3 text-sm">
                <div className="font-medium">{row.event.eventType} · {row.state}</div>
                <div className="text-muted-foreground">{row.eventId} · intentos: {row.attemptCount}{row.lastError ? ` · ${row.lastError}` : ""}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      </>)}
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
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
        title="Copiar"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function FieldTable({ fields }: { fields: { field: string; type: string; required: boolean; description: string }[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b">
            <th className="pr-4 text-left font-medium">Campo</th>
            <th className="pr-4 text-left font-medium">Tipo</th>
            <th className="pr-4 text-left font-medium">Oblig.</th>
            <th className="text-left font-medium">Descripción</th>
          </tr>
        </thead>
        <tbody className="text-muted-foreground">
          {fields.map((f) => (
            <tr key={f.field} className="border-b last:border-0">
              <td className="pr-4 font-mono text-foreground">{f.field}</td>
              <td className="pr-4"><Badge variant="outline" className="font-mono text-[10px]">{f.type}</Badge></td>
              <td className="pr-4">{f.required ? <span className="text-foreground">Sí</span> : "No"}</td>
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
            <h4 className="text-xs font-semibold">Cuándo se emite</h4>
            <p className="text-xs text-muted-foreground">{when}</p>
          </div>

          <div className="space-y-1">
            <h4 className="text-xs font-semibold">Casos de uso habituales</h4>
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
              {useCases.map((uc, i) => <li key={i}>{uc}</li>)}
            </ul>
          </div>

          <div className="space-y-1">
            <h4 className="text-xs font-semibold">Envelope — campos comunes</h4>
            <FieldTable fields={envelopeFields} />
          </div>

          <div className="space-y-1">
            <h4 className="text-xs font-semibold">Payload — campos específicos del evento</h4>
            <FieldTable fields={payloadFields} />
          </div>

          <div className="space-y-1">
            <h4 className="text-xs font-semibold">Ejemplo</h4>
            <CodeBlock code={example} />
          </div>

          {notes && notes.length > 0 && (
            <div className="space-y-1">
              <h4 className="text-xs font-semibold">Consideraciones</h4>
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
  const envelopeFields = [
    { field: "id", type: "string", required: true, description: "ID de evento estable, generado como evt:{type}:{tenantId}:{...}. Usar para deduplicación." },
    { field: "type", type: "string", required: true, description: "Tipo de evento, p. ej. inbound.message.received." },
    { field: "version", type: "number", required: true, description: "Versión del contrato de eventos. Actualmente 1." },
    { field: "tenantId", type: "string", required: true, description: "ID del tenant que posee este evento. No se comparten eventos entre tenants." },
    { field: "occurredAt", type: "string (ISO 8601)", required: true, description: "Momento en que ocurrió el evento, en UTC (RFC 3339)." },
    { field: "recordedAt", type: "string (ISO 8601)", required: true, description: "Momento en que el productor materializó el evento." },
    { field: "entities", type: "array", required: true, description: "Referencias canónicas (tenant, waba, phone, conversation, message, contact)." },
    { field: "meta.producer", type: "string", required: true, description: 'Etiqueta del productor, p. ej. "whatsapp-business-admin".' },
    { field: "meta.correlationId", type: "string?", required: false, description: "ID opcional que vincula el evento con causación upstream." },
    { field: "payload", type: "object", required: true, description: "Datos específicos del tipo de evento (campos propios más abajo)." },
  ];

  const inboundEnvelopeFields = envelopeFields;

  const inboundPayloadFields = [
    { field: "conversationId", type: "string", required: true, description: "ID de la conversación dentro de la plataforma." },
    { field: "messageId", type: "string", required: true, description: "ID del mensaje dentro de la plataforma." },
    { field: "contactId", type: "string", required: true, description: "ID del contacto que envió el mensaje." },
    { field: "phoneNumberId", type: "string", required: true, description: "ID del número de teléfono que recibió el mensaje." },
    { field: "wabaAccountId", type: "string", required: true, description: "ID de la cuenta de WhatsApp Business." },
    { field: "type", type: "string", required: true, description: "Tipo de mensaje: TEXT, IMAGE, VIDEO, AUDIO, DOCUMENT, STICKER, LOCATION, INTERACTIVE, BUTTON, REACTION, CONTACTS, TEMPLATE." },
    { field: "receivedAt", type: "string (ISO 8601)", required: true, description: "Marca de tiempo del momento en que se recibió el mensaje." },
    { field: "providerMessageId", type: "string?", required: false, description: "ID del mensaje en Meta (wamid.*), solo referencia." },
    { field: "preview", type: "string?", required: false, description: "Vista previa truncada del cuerpo del mensaje (máx. 140 chars). Nunca se expone el cuerpo completo." },
  ];

  const outboundAcceptedPayloadFields = [
    { field: "conversationId", type: "string", required: true, description: "ID de la conversación dentro de la plataforma." },
    { field: "messageId", type: "string", required: true, description: "ID del mensaje dentro de la plataforma." },
    { field: "contactId", type: "string", required: true, description: "ID del contacto destinatario." },
    { field: "phoneNumberId", type: "string", required: true, description: "ID del número de teléfono desde el que se envió." },
    { field: "wabaAccountId", type: "string", required: true, description: "ID de la cuenta de WhatsApp Business." },
    { field: "type", type: "string", required: true, description: "Tipo de mensaje enviado." },
    { field: "acceptedAt", type: "string (ISO 8601)", required: true, description: "Momento en que Meta aceptó el mensaje." },
    { field: "providerMessageId", type: "string?", required: false, description: "ID asignado por Meta tras el ack (wamid.*)." },
  ];

  const outboundStatusPayloadFields = [
    { field: "conversationId", type: "string", required: true, description: "ID de la conversación." },
    { field: "messageId", type: "string", required: true, description: "ID del mensaje dentro de la plataforma." },
    { field: "phoneNumberId", type: "string", required: true, description: "ID del número de teléfono." },
    { field: "wabaAccountId", type: "string", required: true, description: "ID de la cuenta de WhatsApp Business." },
    { field: "previousStatus", type: "string | null", required: true, description: "Estado anterior del mensaje. Puede ser null en la primera notificación." },
    { field: "status", type: "string", required: true, description: "Nuevo estado: PENDING, SENT, DELIVERED, READ, FAILED, RECEIVED." },
    { field: "changedAt", type: "string (ISO 8601)", required: true, description: "Momento del cambio de estado." },
    { field: "providerMessageId", type: "string?", required: false, description: "ID del mensaje en Meta (wamid.*)." },
  ];

  const conversationPayloadFields = [
    { field: "conversationId", type: "string", required: true, description: "ID de la conversación." },
    { field: "contactId", type: "string", required: true, description: "ID del contacto asociado." },
    { field: "phoneNumberId", type: "string | null", required: true, description: "ID del número de teléfono asociado." },
    { field: "wabaAccountId", type: "string | null", required: true, description: "ID de la cuenta de WhatsApp Business." },
    { field: "kind", type: "string", required: true, description: "Tipo de cambio: CREATED (nueva conversación), STATUS_CHANGED (cambio de estado), REASSIGNED (reasignación)." },
    { field: "status", type: "string | null", required: true, description: "Estado: OPEN (abierta), CLOSED (cerrada). null en eventos de tipo CREATED." },
    { field: "occurredAt", type: "string (ISO 8601)", required: true, description: "Momento del cambio." },
  ];

  return (
    <div className="max-w-3xl space-y-6">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Introducción</h2>
        <p className="text-xs text-muted-foreground">
          Los webhooks salientes permiten que el sistema notifique a aplicaciones externas en tiempo real
          cuando ocurre un evento de mensajería o conversación. Un consumidor típico registra una URL
          de endpoint HTTPS y suscribe los eventos que le interesan. Cada evento se entrega como una
          solicitud HTTP POST con un cuerpo JSON canónico, firmado con HMAC-SHA256 para permitir
          verificación de autenticidad e integridad.
        </p>
        <p className="text-xs text-muted-foreground">
          El contrato de eventos está versionado (versión 1). Todos los campos son opcionales
          a nivel de TypeScript solo cuando así lo declara el contrato; los campos marcados como
          obligatorios siempre estarán presentes.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Entrega de eventos</h2>
        <div className="space-y-2">
          <div className="grid grid-cols-[120px_1fr] gap-1 text-xs">
            <span className="font-medium text-muted-foreground">Método</span>
            <span>HTTP POST, application/json</span>
            <span className="font-medium text-muted-foreground">Autenticación</span>
            <span>HMAC-SHA256 con secreto compartido. Encabezados: <code className="rounded-sm bg-muted px-1">X-WBA-Timestamp</code> y <code className="rounded-sm bg-muted px-1">X-WBA-Signature</code>. El cuerpo se firma como <code className="rounded-sm bg-muted px-1">timestamp.body</code> usando HMAC-SHA256. Tolerancia de 5 min.</span>
            <span className="font-medium text-muted-foreground">Encabezados</span>
            <span><code className="rounded-sm bg-muted px-1">X-Canonical-Event-Id</code> (ID del evento), <code className="rounded-sm bg-muted px-1">X-Canonical-Tenant-Id</code> (tenant)</span>
            <span className="font-medium text-muted-foreground">Timeout</span>
            <span>5 segundos (máx. configurable hasta 30 s)</span>
            <span className="font-medium text-muted-foreground">Reintentos</span>
            <span>Máx. 5 intentos con backoff exponencial (1 s – 60 s) y jitter. Se agotan después de 5 intentos fallidos.</span>
            <span className="font-medium text-muted-foreground">Respuestas</span>
            <span>2xx = aceptado. 4xx = error terminal (no se reintenta). 5xx / timeout / 429 = reintentable.</span>
            <span className="font-medium text-muted-foreground">Idempotencia</span>
            <span>El ID de evento es estable y determinista. Un consumidor que recibe el mismo ID dos veces debe tratar la segunda entrega como duplicado.</span>
            <span className="font-medium text-muted-foreground">Orden</span>
            <span>No hay garantía de orden entre eventos de diferentes tipos. Para eventos del mismo mensaje (p. ej. accepted → delivered → read), el orden de occurrence se preserva.</span>
            <span className="font-medium text-muted-foreground">URLs</span>
            <span>Solo HTTPS en producción. HTTP localhost permitido solo en pruebas.</span>
            <span className="font-medium text-muted-foreground">Seguridad</span>
            <span>SSRF: se resuelve el hostname una vez y se fija la conexión a esa IP. Credenciales en la URL no están permitidas. IPs privadas están bloqueadas.</span>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Envelope canónico</h2>
        <p className="text-xs text-muted-foreground">Todos los eventos comparten esta estructura. Los campos específicos del evento están en <code className="rounded-sm bg-muted px-1">payload</code>.</p>
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
        <h2 className="text-sm font-semibold">Eventos disponibles</h2>
        <p className="text-xs text-muted-foreground">Haga clic en un evento para expandir los detalles y el ejemplo.</p>

        <EventCard
          eventType="inbound.message.received"
          title="Mensaje entrante recibido"
          description="Se emite cuando llega un mensaje de un contacto al número de WhatsApp Business."
          when="Cuando WhatsApp entrega un mensaje de texto, multimedia, ubicación, sticker, botón o interactivo al webhook de Meta."
          useCases={[
            "Sincronizar conversaciones en un CRM o plataforma de automatización.",
            "Activar un chatbot o flujo de automatización en Mastra / n8n.",
            "Crear tickets en un sistema de soporte cuando llega un mensaje.",
            "Extraer datos de formularios de WhatsApp Flows completados.",
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
            "El cuerpo completo del mensaje NO se incluye. Solo una vista previa truncada a 140 caracteres.",
            "La conversación ya existe o se crea automáticamente en la plataforma.",
            "El mensaje se marca como RECEIVED tras este evento.",
          ]}
        />

        <EventCard
          eventType="outbound.message.accepted"
          title="Mensaje saliente aceptado"
          description="Se emite cuando Meta confirma la aceptación de un mensaje saliente enviado a través de la API."
          when="Cuando WhatsApp reconoce un mensaje enviado y le asigna un ID de proveedor (wamid)."
          useCases={[
            "Confirmar que un mensaje fue recibido por Meta antes de marcarlo como enviado.",
            "Validar que el número de teléfono es reachable antes de enviar mensajes en cadena.",
            "Auditar volúmenes de mensajería enviada.",
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
            "Este evento confirma que Meta recibió la solicitud, no que el destinatario lo leyó.",
            "Si Meta rechaza el número (no reachable), el evento no se emite; se emite outbound.message.status_changed con status: FAILED.",
          ]}
        />

        <EventCard
          eventType="outbound.message.status_changed"
          title="Cambio de estado de mensaje saliente"
          description="Se emite cuando cambia el estado de entrega de un mensaje saliente (enviado, entregado, leído, fallido)."
          when="Cuando Meta notifica un cambio de estado en la entrega del mensaje (sent, delivered, read, failed)."
          useCases={[
            "Actualizar el estado de mensajes en un CRM o dashboard de operadores.",
            "Notificar al usuario cuando su mensaje es leído (read receipt).",
            "Reintentar o marcar como fallido en un sistema de seguimiento de campañas.",
            "Detectar números no reachable para depurar tasas de entrega.",
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
            "Los estados posibles son: PENDING, SENT, DELIVERED, READ, FAILED, RECEIVED.",
            "La monotonicidad se respeta: un estado no puede degradarse (read no puede llegar antes que delivered).",
            "Si previousStatus y status son iguales, el evento no se emite.",
            "Este evento no incluye contactId porque es optional en el contrato del mensaje.",
          ]}
        />

        <EventCard
          eventType="conversation.changed"
          title="Conversación modificada"
          description="Se emite cuando se crea una nueva conversación o cambia su estado (abierta/cerrada)."
          when="Cuando llega el primer mensaje de un contacto (crea conversación OPEN) o cuando un operador cierra/reabre la conversación."
          useCases={[
            "Abrir automáticamente tickets de soporte al recibir un mensaje de un cliente nuevo.",
            "Notificar a un equipo cuando una conversación pasa a estado CLOSED para revisión.",
            "Limpiar conversaciones inactivas en sistemas externos.",
            "Detectar cuando un cliente inicia una nueva sesión de atención.",
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
            'kind: CREATED = conversación nueva. STATUS_CHANGED = cambio de estado. REASSIGNED = reasignación de operador.',
            'status: OPEN (abierta) o CLOSED (cerrada). null en kind: CREATED.',
            "Si kind y status son iguales a los anteriores, el evento no se emite.",
          ]}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Verificar la firma</h2>
        <p className="text-xs text-muted-foreground">
          Si el destino tiene un secreto configurado, cada request incluye{" "}
          <code className="rounded-sm bg-muted px-1">X-WBA-Timestamp</code> y{" "}
          <code className="rounded-sm bg-muted px-1">X-WBA-Signature</code>. El cuerpo
          se firma con HMAC-SHA256 sobre <code className="rounded-sm bg-muted px-1">timestamp.body</code>.
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
        <h2 className="text-sm font-semibold">Convenciones importantes</h2>
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>
            <strong>IDs estables:</strong> todos los IDs (conversationId, messageId, contactId…) son
            IDs internos de la plataforma. No asumir formato de Meta.
          </li>
          <li>
            <strong>Deduplicación:</strong> usar <code className="rounded-sm bg-muted px-1">id</code>
            {" "}del envelope para detectar duplicados. El mismo evento nunca se entrega dos veces
            en circunstancias normales, pero la idempotencia es buena práctica.
          </li>
          <li>
            <strong>Occurrence vs. recording:</strong> <code className="rounded-sm bg-muted px-1">occurredAt</code>{" "}
            es el momento real del evento; <code className="rounded-sm bg-muted px-1">recordedAt</code> es
            cuando se persistió. Consumers deben usar <code className="rounded-sm bg-muted px-1">occurredAt</code>{" "}
            para ordenar.
          </li>
          <li>
            <strong>Sin secretos ni PII:</strong> los payloads de eventos nunca contienen tokens,
            secretos ni contenido de mensajes entrantes.
          </li>
          <li>
            <strong>Teléfono sin +:</strong> los IDs de teléfono son IDs internos de la plataforma,
            no números de teléfono en formato E.164.
          </li>
        </ul>
      </section>
    </div>
  );
}
