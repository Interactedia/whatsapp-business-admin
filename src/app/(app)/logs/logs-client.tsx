"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/shell/page-header";
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

export function LogsClient() {
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

  const { data, isLoading } = useQuery({
    queryKey: ["logs", tab, page, apiFilters],
    queryFn: () => apiFetch<Feed<SanitizedApiLog | WebhookEvent>>(buildApiUrl(tab, page, apiFilters)),
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

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

  const hasFilters = from || to || method || endpoint || okFilter || related || sig || processed;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Logs"
        description="Operational visibility into outbound API calls and inbound webhook events."
        actions={
          <Tabs value={tab} onValueChange={(v) => switchTab(v as "api" | "webhook")}>
            <TabsList>
              <TabsTrigger value="api">API calls</TabsTrigger>
              <TabsTrigger value="webhook">Webhooks</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        {tab === "api" ? (
          <>
            <FilterInput placeholder="Method" value={method} onChange={setMethod} />
            <FilterInput placeholder="Endpoint… (partial match)" value={endpoint} onChange={setEndpoint} />
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
        <FilterInput type="datetime-local" placeholder="From" value={from} onChange={setFrom} />
        <FilterInput type="datetime-local" placeholder="To" value={to} onChange={setTo} />
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1 text-muted-foreground"
            onClick={() => {
              setMethod(""); setEndpoint(""); setOkFilter(""); setRelated("");
              setSig(""); setProcessed(""); setFrom(""); setTo("");
            }}
          >
            <X className="h-3 w-3" /> Clear
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 p-3 sm:p-4">
        <div className="rounded-lg border">
          {tab === "api" ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-40">Time</TableHead>
                  <TableHead className="w-16">Method</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Endpoint</TableHead>
                  <TableHead className="w-20">Status</TableHead>
                  <TableHead className="w-20">Duration</TableHead>
                  <TableHead className="w-24">Related</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && <Empty cols={6} text="Loading…" />}
                {!isLoading && data?.items.length === 0 && <Empty cols={6} text="No API calls match the filters." />}
                {(data?.items as SanitizedApiLog[] | undefined)?.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell data-label="Time" className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(log.createdAt)}</TableCell>
                    <TableCell data-label="Method"><Badge variant="outline">{log.method}</Badge></TableCell>
                    <TableCell data-label="Tenant" className="text-xs text-muted-foreground">{tenantLabel(log)}</TableCell>
                    <TableCell data-label="Endpoint" className="max-w-0 break-all font-mono text-xs md:truncate">{log.endpoint}</TableCell>
                    <TableCell data-label="Status">
                      <Badge variant={log.ok ? "success" : "destructive"}>{log.responseStatus ?? "—"}</Badge>
                    </TableCell>
                    <TableCell data-label="Duration" className="text-xs text-muted-foreground">{log.durationMs != null ? `${log.durationMs} ms` : "—"}</TableCell>
                    <TableCell data-label="Related" className="text-xs text-muted-foreground">{log.relatedType ?? "—"}</TableCell>
                    <TableCell><Button variant="outline" size="sm" onClick={async () => setDetail({ title: "Detalle HTTP", body: await apiFetch(`/api/logs/api/${log.id}`) })}>Ver detalle</Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-40">Time</TableHead>
                  <TableHead>Summary</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead className="w-24">Signature</TableHead>
                  <TableHead className="w-24">Processed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && <Empty cols={4} text="Loading…" />}
                {!isLoading && data?.items.length === 0 && <Empty cols={4} text="No webhooks match the filters." />}
                {(data?.items as WebhookEvent[] | undefined)?.map((ev) => (
                  <TableRow key={ev.id}>
                    <TableCell data-label="Time" className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(ev.createdAt)}</TableCell>
                    <TableCell data-label="Summary" className="text-xs">{ev.eventSummary || ev.error || "—"}</TableCell>
                    <TableCell data-label="Tenant" className="text-xs text-muted-foreground">{tenantLabel(ev)}</TableCell>
                    <TableCell data-label="Signature">
                      <Badge variant={ev.signatureValid ? "success" : "warning"}>{ev.signatureValid ? "valid" : "unverified"}</Badge>
                    </TableCell>
                    <TableCell data-label="Processed">
                      <Badge variant={ev.processedOk ? "success" : "destructive"}>{ev.processedOk ? "ok" : "error"}</Badge>
                    </TableCell>
                    <TableCell><Button variant="outline" size="sm" onClick={async () => setDetail({ title: "Detalle webhook", body: await apiFetch(`/api/logs/webhook/${ev.id}`) })}>Ver detalle</Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {/* Pagination */}
        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>{data?.total ?? 0} total · page size {data?.pageSize}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span>Page {page} / {totalPages}</span>
            <Button variant="outline" size="icon" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
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

function FilterInput({ placeholder, value, onChange, type }: { placeholder: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <Input
      type={type ?? "text"}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-36"
    />
  );
}

function FilterSelect({ value, onValueChange, placeholder, children }: { value: string; onValueChange: (v: string) => void; placeholder: string; children: React.ReactNode }) {
  return (
    <Select value={value || undefined} onValueChange={(v) => { onValueChange(v); }}>
      <SelectTrigger className="h-8 w-32">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}

function Empty({ cols, text }: { cols: number; text: string }) {
  return (
    <TableRow>
      <TableCell colSpan={cols} className="py-6 text-center text-muted-foreground">
        {text}
      </TableCell>
    </TableRow>
  );
}
