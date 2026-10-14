"use client";

import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Filter,
  Inbox,
  Loader2,
  RefreshCw,
  Table2,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { cn, formatDateTime } from "@/lib/utils";
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

  // ---- display-only derivations (no logic changes) ----
  const shownItems = data?.items ?? [];
  const fromIndex = data && shownItems.length > 0 ? (data.page - 1) * data.pageSize + 1 : 0;
  const toIndex = data ? Math.min((data.page - 1) * data.pageSize + shownItems.length, data.total) : 0;

  return (
    <div className="flex h-full flex-col">
      {/* Page Header */}
      <div className="border-b bg-card px-4 py-5 sm:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Logs</h1>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Consulta llamadas API y eventos de webhooks para diagnosticar la actividad del sistema.
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            {dataUpdatedAt > 0 && (
              <span className="hidden text-xs text-muted-foreground sm:inline">
                Última actualización: {formatTime(new Date(dataUpdatedAt))}
              </span>
            )}
            <Button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="h-10 gap-2 rounded-lg px-4 text-sm font-medium shadow-sm transition-colors"
            >
              <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
              {isRefreshing ? "Actualizando…" : "Actualizar"}
            </Button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b bg-card px-4 py-2 sm:px-6">
        <Tabs value={tab} onValueChange={(v) => switchTab(v as "api" | "webhook")}>
          <TabsList className="h-10 gap-1 bg-transparent p-0 sm:justify-start">
            <TabsTrigger
              value="api"
              className="h-10 rounded-lg border border-transparent px-4 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground data-[state=active]:border-primary/20 data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none"
            >
              API calls
            </TabsTrigger>
            <TabsTrigger
              value="webhook"
              className="h-10 rounded-lg border border-transparent px-4 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground data-[state=active]:border-primary/20 data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none"
            >
              Webhooks
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Filter panel */}
      <div className="px-4 pt-4 sm:px-6 sm:pt-6">
        <div className="rounded-lg border bg-card p-5 shadow-xs">
          <div className="mb-4 flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Filtros</h2>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-12">
            {tab === "api" ? (
              <>
                <div className="lg:col-span-2">
                  <FilterInput label="Method" placeholder="GET, POST…" value={method} onChange={setMethod} className="w-full" />
                </div>
                <div className="lg:col-span-4">
                  <FilterInput label="Endpoint" placeholder="Coincidencia parcial…" value={endpoint} onChange={setEndpoint} className="w-full" />
                </div>
                <div className="lg:col-span-3">
                  <FilterSelect label="Status" value={okFilter} onValueChange={setOkFilter} placeholder="Todos">
                    <SelectItem value="true">Success</SelectItem>
                    <SelectItem value="false">Failed</SelectItem>
                  </FilterSelect>
                </div>
                <div className="lg:col-span-3">
                  <FilterSelect label="Related" value={related} onValueChange={setRelated} placeholder="Todos">
                    <SelectItem value="template">Template</SelectItem>
                    <SelectItem value="message">Message</SelectItem>
                    <SelectItem value="broadcast">Broadcast</SelectItem>
                    <SelectItem value="media-upload">Media</SelectItem>
                  </FilterSelect>
                </div>
              </>
            ) : (
              <>
                <div className="lg:col-span-3">
                  <FilterSelect label="Signature" value={sig} onValueChange={setSig} placeholder="Todas">
                    <SelectItem value="valid">Valid</SelectItem>
                    <SelectItem value="invalid">Unverified</SelectItem>
                  </FilterSelect>
                </div>
                <div className="lg:col-span-3">
                  <FilterSelect label="Processed" value={processed} onValueChange={setProcessed} placeholder="Todos">
                    <SelectItem value="ok">OK</SelectItem>
                    <SelectItem value="error">Error</SelectItem>
                  </FilterSelect>
                </div>
              </>
            )}
            <div className={tab === "api" ? "lg:col-span-4" : "lg:col-span-3"}>
              <FilterInput type="datetime-local" label="Desde" value={from} onChange={setFrom} className="w-full" />
            </div>
            <div className={tab === "api" ? "lg:col-span-4" : "lg:col-span-3"}>
              <FilterInput type="datetime-local" label="Hasta" value={to} onChange={setTo} className="w-full" />
            </div>
            <div
              className={cn(
                "flex items-end",
                tab === "api" ? "lg:col-span-4" : "lg:col-span-6",
                "lg:justify-end",
              )}
            >
              {hasFilters && (
                <Button
                  variant="outline"
                  className="h-10 w-full gap-1.5 rounded-lg text-sm font-normal text-muted-foreground sm:w-auto"
                  onClick={clearFilters}
                >
                  <X className="h-3.5 w-3.5" /> Limpiar filtros
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Error Banner */}
      {isError && (
        <div className="px-4 pt-4 sm:px-6 sm:pt-6">
          <div className="flex items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-4">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1 text-sm text-destructive">
              <p className="font-medium">No se pudieron cargar los registros.</p>
              <p className="mt-0.5 text-destructive/80">
                Verifica la conexión con el servidor e inténtalo de nuevo.{" "}
                <Button variant="link" size="sm" className="h-auto p-0 text-destructive underline-offset-4 hover:underline" onClick={handleRefresh}>
                  Intentar nuevamente
                </Button>
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Results card */}
      <div className="flex-1 overflow-auto p-4 pt-4 sm:p-6 sm:pt-6">
        <div className="overflow-hidden rounded-lg border bg-card shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-4 py-3">
            <div className="flex items-center gap-2">
              <Table2 className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground">Resultados</h2>
              {data && !isError && (
                <Badge variant="secondary" className="ml-1 rounded-full px-2 py-0 text-xs font-medium tabular-nums">
                  {data.total}
                </Badge>
              )}
            </div>
            {data && !isError && shownItems.length > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                Mostrando {fromIndex}–{toIndex} de {data.total}
              </span>
            )}
          </div>

          {tab === "api" ? (
            <Table>
              <TableHeader className="[&_th]:h-10 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-slate-500">
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
              <TableBody className="[&_tr:not(.row-empty)_td]:py-2.5">
                {isLoading && <Empty cols={8} icon={Loader2} iconClassName="animate-spin" text="Cargando registros…" />}
                {!isLoading && data?.items.length === 0 && <Empty cols={8} icon={Inbox} text="No hay registros que coincidan con los filtros." />}
                {!isLoading && isError && !data && <Empty cols={8} icon={AlertTriangle} text="Error al cargar los registros." />}
                {(data?.items as SanitizedApiLog[] | undefined)?.map((log) => (
                  <TableRow key={log.id} className="group hover:bg-muted/40">
                    <TableCell data-label="Time" className="pl-4 whitespace-nowrap text-[13px] text-muted-foreground">{formatDateTime(log.createdAt)}</TableCell>
                    <TableCell data-label="Method"><Badge variant="outline" className="font-mono text-xs font-medium">{log.method}</Badge></TableCell>
                    <TableCell data-label="Tenant" className="text-[13px] text-muted-foreground max-w-[140px] truncate">{tenantLabel(log)}</TableCell>
                    <TableCell data-label="Endpoint" className="font-mono text-[13px] max-w-[220px] truncate" title={log.endpoint}>{log.endpoint}</TableCell>
                    <TableCell data-label="Status" className="text-center">
                      <Badge variant={log.ok ? "success" : "destructive"} className="font-normal tabular-nums">
                        {log.responseStatus ?? "—"}
                      </Badge>
                    </TableCell>
                    <TableCell data-label="Duration" className="text-right text-[13px] text-muted-foreground tabular-nums">{log.durationMs != null ? `${log.durationMs} ms` : "—"}</TableCell>
                    <TableCell data-label="Related" className="text-[13px] text-muted-foreground">{log.relatedType ?? "—"}</TableCell>
                    <TableCell className="pr-4">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
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
              <TableHeader className="[&_th]:h-10 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-slate-500">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4 w-40">Time</TableHead>
                  <TableHead>Summary</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead className="w-24 text-center">Signature</TableHead>
                  <TableHead className="w-24 text-center">Processed</TableHead>
                  <TableHead className="pr-4 w-24"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_tr:not(.row-empty)_td]:py-2.5">
                {isLoading && <Empty cols={6} icon={Loader2} iconClassName="animate-spin" text="Cargando registros…" />}
                {!isLoading && data?.items.length === 0 && <Empty cols={6} icon={Inbox} text="No hay webhooks que coincidan con los filtros." />}
                {!isLoading && isError && !data && <Empty cols={6} icon={AlertTriangle} text="Error al cargar los registros." />}
                {(data?.items as WebhookEvent[] | undefined)?.map((ev) => (
                  <TableRow key={ev.id} className="group hover:bg-muted/40">
                    <TableCell data-label="Time" className="pl-4 whitespace-nowrap text-[13px] text-muted-foreground">{formatDateTime(ev.createdAt)}</TableCell>
                    <TableCell data-label="Summary" className="text-[13px] max-w-[220px] truncate" title={ev.eventSummary || ev.error || undefined}>{ev.eventSummary || ev.error || "—"}</TableCell>
                    <TableCell data-label="Tenant" className="text-[13px] text-muted-foreground max-w-[140px] truncate">{tenantLabel(ev)}</TableCell>
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
                        className="h-7 px-2 text-xs opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
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

          {/* Pagination */}
          {!isLoading && !isError && data && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
              <span className="tabular-nums">{data.total} registros · {data.pageSize} por página</span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  disabled={page <= 1 || isRefreshing}
                  onClick={() => setPage((p) => p - 1)}
                  className="h-8 w-8 rounded-lg"
                  aria-label="Página anterior"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="min-w-[90px] text-center tabular-nums">
                  Página {page} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  disabled={page >= totalPages || isRefreshing}
                  onClick={() => setPage((p) => p + 1)}
                  className="h-8 w-8 rounded-lg"
                  aria-label="Página siguiente"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
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
    <div className="flex flex-col gap-1.5">
      {label && (
        <span className="text-xs font-medium text-slate-600">{label}</span>
      )}
      <Input
        type={type ?? "text"}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label ?? placeholder}
        className={cn("h-10 rounded-lg", className ?? "w-full")}
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
    <div className="flex flex-col gap-1.5">
      {label && (
        <span className="text-xs font-medium text-slate-600">{label}</span>
      )}
      <Select value={value || undefined} onValueChange={(v) => { onValueChange(v); }}>
        <SelectTrigger className="h-10 w-full rounded-lg" aria-label={label ?? placeholder}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>{children}</SelectContent>
      </Select>
    </div>
  );
}

function Empty({
  cols,
  text,
  icon: Icon,
  iconClassName,
}: {
  cols: number;
  text: string;
  icon: React.ComponentType<{ className?: string }>;
  iconClassName?: string;
}) {
  return (
    <TableRow className="row-empty hover:bg-transparent">
      <TableCell colSpan={cols} className="py-14 text-center">
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-muted">
            <Icon className={cn("h-5 w-5 text-muted-foreground", iconClassName)} />
          </div>
          <p className="text-sm text-muted-foreground">{text}</p>
        </div>
      </TableCell>
    </TableRow>
  );
}
