"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, RotateCcw, Send, Trash2 } from "lucide-react";
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
    </div>
  );
}
