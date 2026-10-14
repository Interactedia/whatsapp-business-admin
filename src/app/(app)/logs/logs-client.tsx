"use client";

import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, RefreshCw, X } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type TenantLabel = { id: string; name: string } | null;

type ApiLog = {
  id: string;
  tenantId: string | null;
  tenant?: TenantLabel;
  method: string;
  endpoint: string;
  requestBody: unknown;
  responseStatus: number | null;
  responseBody: unknown;
  ok: boolean;
  durationMs: number | null;
  relatedType: string | null;
  relatedId: string | null;
  createdAt: string;
};

type WebhookEvent = {
  id: string;
  tenantId: string | null;
  tenant?: TenantLabel;
  payload: unknown;
  signatureValid: boolean;
  processedOk: boolean;
  eventSummary: string | null;
  error: string | null;
  createdAt: string;
};

type Feed<T> = { type: string; items: T[]; total: number; page: number; pageSize: number };

function tenantLabel(item: { tenantId: string | null; tenant?: TenantLabel }) {
  if (item.tenant) return `${item.tenant.name} (${item.tenant.id})`;
  return item.tenantId ? item.tenantId : "Sin resolver";
}

// ---- sanitized display: never expose raw request/response bodies to the browser ----
type SanitizedApiLog = Omit<ApiLog, "requestBody" | "responseBody">;

function buildApiUrl(tab: "api" | "webhook", page: number, filters: Record<string, string>): string {
  const params = new URLSearchParams({ type: tab, page: String(page) });
  for (const [k, v] of Object.entries(filters)) {
    if (v) params.set(k, v);
  }
  return `/api/logs?${params.toString()}`;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function LogsClient() {
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<"api" | "webhook">("api");
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<{ title: string; body: unknown } | null>(null);

  // API log filters
  const [method, setMethod] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [okFilter, setOkFilter] = useState("");
  const [related, setRelated] = useState("");

  // Webhook filters
  const [sig, setSig] = useState("");
  const [processed, setProcessed] = useState("");

  // Date filters (shared)
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const apiFilters: Record<string, string> = {};
  if (from) apiFilters.from = from;
  if (to) apiFilters.to = to;
  if (tab === "api") {
    if (method) apiFilters.method = method;
    if (endpoint) apiFilters.endpoint = endpoint;
    if (okFilter) apiFilters.ok = okFilter;
    if (related) apiFilters.related = related;
  } else {
    if (sig) apiFilters.sig = sig;
    if (processed) apiFilters.processed = processed;
  }

  const { data, isLoading, isFetching, isError, dataUpdatedAt } = useQuery({
    queryKey: ["logs", tab, page, apiFilters],
    queryFn: () => apiFetch<Feed<SanitizedApiLog | WebhookEvent>>(buildApiUrl(tab, page, apiFilters)),
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const isRefreshing = isFetching;

  const handleRefresh = useCallback(async () => {
    if (isRefreshing) return;
    await queryClient.invalidateQueries({ queryKey: ["logs"] });
  }, [isRefreshing, queryClient]);

  function switchTab(t: "api" | "webhook") {
    setTab(t);
    setPage(1);
    setMethod("");
    setEndpoint("");
    setOkFilter("");
    setRelated("");
    setSig("");
    setProcessed("");
    setFrom("");
    setTo("");
  }

  function clearFilters() {
    setMethod("");
    setEndpoint("");
    setOkFilter("");
    setRelated("");
    setSig("");
    setProcessed("");
    setFrom("");
    setTo("");
  }

  const hasFilters = from || to || method || endpoint || okFilter || related || sig || processed;

  return (
    <div className="flex h-full flex-col">
      {/* Page Header */}
      <div className="border-b bg-card px-4 py-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-base font-semibold text-foreground">Logs</h1>
          <p className="text-xs text-muted-foreground">
            Consulta llamadas API y eventos de webhooks para diagnosticar la actividad del sistema.
          </p>
        </div>
      </div>

      {/* Tabs + Refresh Row */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
        <Tabs value={tab} onValueChange={(v) => switchTab(v as "api" | "webhook")}>
          <TabsList>
            <TabsTrigger value="api">API calls</TabsTrigger>
            <TabsTrigger value="webhook">Webhooks</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex items-center gap-3">
          {dataUpdatedAt > 0 && (
            <span className="text-xs text-muted-foreground">
              Última actualización: {formatTime(new Date(dataUpdatedAt))}
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="gap-1.5"
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
            {isRefreshing ? "Actualizando..." : "Actualizar"}
          </Button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        {tab === "api" ? (
          <>
            <FilterInput placeholder="Method" value={method} onChange={setMethod} />
            <FilterInput placeholder="Endpoint… (partial match)" value={endpoint} onChange={setEndpoint} className="w-44" />
            <FilterSelect value={okFilter} onValueChange={setOkFilter} placeholder="Status">
              <SelectItem value="true">Success</SelectItem>
              <SelectItem value="false">Failed</SelectItem>
            </FilterSelect>
            <FilterSelect value={related} onValueChange={setRelated} placeholder="Related">
              <SelectItem value="template">Template</SelectItem>
              <SelectItem value="message">Message</SelectItem>
              <SelectItem value="broadcast">Broadcast</SelectItem>
              <SelectItem value="media-upload">Media</SelectItem>
            </FilterSelect>
          </>
        ) : (
          <>
            <FilterSelect value={sig} onValueChange={setSig} placeholder="Signature">
              <SelectItem value="valid">Valid</SelectItem>
              <SelectItem value="invalid">Unverified</SelectItem>
            </FilterSelect>
            <FilterSelect value={processed} onValueChange={setProcessed} placeholder="Processed">
              <SelectItem value="ok">OK</SelectItem>
              <SelectItem value="error">Error</SelectItem>
            </FilterSelect>
          </>
        )}
        <FilterInput type="datetime-local" label="Desde" value={from} onChange={setFrom} />
        <FilterInput type="datetime-local" label="Hasta" value={to} onChange={setTo} />
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1 text-muted-foreground"
            onClick={clearFilters}
          >
            <X className="h-3 w-3" /> Limpiar filtros
          </Button>
        )}
      </div>

      {/* Error Banner */}
      {isError && (
        <div className="mx-4 mt-4 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
          <p className="text-sm text-destructive">
            Error al cargar los registros.{" "}
            <Button variant="link" size="sm" className="h-auto p-0 text-destructive" onClick={handleRefresh}>
              Intentar nuevamente
            </Button>
          </p>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto p-4">
        <div className="rounded-lg border bg-card">
          {tab === "api" ? (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4 w-40">Time</TableHead>
                  <TableHead className="w-16">Method</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Endpoint</TableHead>
                  <TableHead className="w-20 text-center">Status</TableHead>
                  <TableHead className="w-20 text-right">Duration</TableHead>
                  <TableHead className="w-24">Related</TableHead>
                  <TableHead className="pr-4 w-24"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && <Empty cols={8} text="Cargando registros..." />}
                {!isLoading && data?.items.length === 0 && <Empty cols={8} text="No hay registros que coincidan con los filtros." />}
                {!isLoading && isError && !data && <Empty cols={8} text="Error al cargar los registros." />}
                {(data?.items as SanitizedApiLog[] | undefined)?.map((log) => (
                  <TableRow key={log.id} className="group hover:bg-accent/50">
                    <TableCell data-label="Time" className="pl-4 whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(log.createdAt)}</TableCell>
                    <TableCell data-label="Method"><Badge variant="outline">{log.method}</Badge></TableCell>
                    <TableCell data-label="Tenant" className="text-xs text-muted-foreground max-w-[120px] truncate">{tenantLabel(log)}</TableCell>
                    <TableCell data-label="Endpoint" className="font-mono text-xs max-w-[200px] truncate">{log.endpoint}</TableCell>
                    <TableCell data-label="Status" className="text-center">
                      <Badge variant={log.ok ? "success" : "destructive"} className="font-normal">
                        {log.responseStatus ?? "—"}
                      </Badge>
                    </TableCell>
                    <TableCell data-label="Duration" className="text-right text-xs text-muted-foreground tabular-nums">{log.durationMs != null ? `${log.durationMs} ms` : "—"}</TableCell>
                    <TableCell data-label="Related" className="text-xs text-muted-foreground">{log.relatedType ?? "—"}</TableCell>
                    <TableCell className="pr-4">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={async () => setDetail({ title: "Detalle HTTP", body: await apiFetch(`/api/logs/api/${log.id}`) })}
                      >
                        Ver
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4 w-40">Time</TableHead>
                  <TableHead>Summary</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead className="w-24 text-center">Signature</TableHead>
                  <TableHead className="w-24 text-center">Processed</TableHead>
                  <TableHead className="pr-4 w-24"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && <Empty cols={6} text="Cargando registros..." />}
                {!isLoading && data?.items.length === 0 && <Empty cols={6} text="No hay webhooks que coincidan con los filtros." />}
                {!isLoading && isError && !data && <Empty cols={6} text="Error al cargar los registros." />}
                {(data?.items as WebhookEvent[] | undefined)?.map((ev) => (
                  <TableRow key={ev.id} className="group hover:bg-accent/50">
                    <TableCell data-label="Time" className="pl-4 whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(ev.createdAt)}</TableCell>
                    <TableCell data-label="Summary" className="text-xs max-w-[200px] truncate">{ev.eventSummary || ev.error || "—"}</TableCell>
                    <TableCell data-label="Tenant" className="text-xs text-muted-foreground max-w-[120px] truncate">{tenantLabel(ev)}</TableCell>
                    <TableCell data-label="Signature" className="text-center">
                      <Badge variant={ev.signatureValid ? "success" : "warning"} className="font-normal">
                        {ev.signatureValid ? "valid" : "unverified"}
                      </Badge>
                    </TableCell>
                    <TableCell data-label="Processed" className="text-center">
                      <Badge variant={ev.processedOk ? "success" : "destructive"} className="font-normal">
                        {ev.processedOk ? "ok" : "error"}
                      </Badge>
                    </TableCell>
                    <TableCell className="pr-4">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={async () => setDetail({ title: "Detalle webhook", body: await apiFetch(`/api/logs/webhook/${ev.id}`) })}
                      >
                        Ver
                      </Button>
                      </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {/* Pagination */}
        {!isLoading && !isError && data && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{data.total} registros · {data.pageSize} por página</span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                disabled={page <= 1 || isRefreshing}
                onClick={() => setPage((p) => p - 1)}
                className="h-8 w-8"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="min-w-[80px] text-center">
                Página {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="icon"
                disabled={page >= totalPages || isRefreshing}
                onClick={() => setPage((p) => p + 1)}
                className="h-8 w-8"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        {detail && (
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle className="font-mono text-xs">{detail.title}</DialogTitle>
            </DialogHeader>
            <pre className="max-h-[60vh] overflow-auto scroll-thin rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(detail.body, null, 2)}
            </pre>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

function FilterInput({
  placeholder,
  value,
  onChange,
  type,
  label,
  className,
}: {
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  label?: string;
  className?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      {label && <span className="text-xs text-muted-foreground">{label}</span>}
      <Input
        type={type ?? "text"}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`h-8 ${className ?? "w-36"}`}
      />
    </div>
  );
}

function FilterSelect({
  value,
  onValueChange,
  placeholder,
  children,
  label,
}: {
  value: string;
  onValueChange: (v: string) => void;
  placeholder: string;
  children: React.ReactNode;
  label?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      {label && <span className="text-xs text-muted-foreground">{label}</span>}
      <Select value={value || undefined} onValueChange={(v) => { onValueChange(v); }}>
        <SelectTrigger className="h-8 w-32">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>{children}</SelectContent>
      </Select>
    </div>
  );
}

function Empty({ cols, text }: { cols: number; text: string }) {
  return (
    <TableRow>
      <TableCell colSpan={cols} className="py-8 text-center text-sm text-muted-foreground">
        {text}
      </TableCell>
    </TableRow>
  );
}
