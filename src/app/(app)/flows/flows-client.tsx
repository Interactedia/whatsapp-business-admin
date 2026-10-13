"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, Pencil, Plus, RefreshCw, Send, Trash2, Upload, Archive } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/use-toast";

type FlowRow = {
  id: string;
  name: string;
  categories: string[];
  retentionDays: number;
  updatedAt: string;
  _count: { launches: number };
  activeVersion: null | { revision: number; status: string; metaFlowId: string | null; previewUrl: string | null; validationErrors: unknown };
};

export function FlowsClient() {
  const qc = useQueryClient();
  const pathname = usePathname();
  const { toast } = useToast();
  const activeTenantId = pathname.match(/^\/t\/([^/]+)/)?.[1] ?? null;
  const { data: flows = [], isLoading } = useQuery({ queryKey: ["flows"], queryFn: () => apiFetch<FlowRow[]>("/api/flows") });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["flows"] });
  const action = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => apiFetch(`/api/flows/${id}/${name}`, { method: "POST" }),
    onSuccess: (_r, variables) => { invalidate(); toast({ title: `Flow ${variables.name} complete` }); },
    onError: (error: Error) => toast({ variant: "destructive", title: "Flow action failed", description: error.message }),
  });
  const sync = useMutation({
    mutationFn: () => apiFetch<{ synced: number }>("/api/flows/sync", { method: "POST", body: JSON.stringify(activeTenantId ? { tenantId: activeTenantId } : {}) }),
    onSuccess: (result) => { invalidate(); toast({ title: `Synced ${result.synced} Flows from Meta` }); },
    onError: (error: Error) => toast({ variant: "destructive", title: "Sync failed", description: error.message }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/flows/${id}`, { method: "DELETE" }),
    onSuccess: () => { invalidate(); toast({ title: "Flow deleted" }); },
    onError: (error: Error) => toast({ variant: "destructive", title: "Delete failed", description: error.message }),
  });

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="WhatsApp Flows" description="Build native multi-screen forms, publish them to Meta, and collect structured responses." actions={<>
        <Button variant="outline" size="sm" onClick={() => sync.mutate()} disabled={sync.isPending}><RefreshCw className={sync.isPending ? "h-4 w-4 animate-spin" : "h-4 w-4"} /> Sync Meta</Button>
        <Button size="sm" asChild><Link href="/flows/new"><Plus className="h-4 w-4" /> New Flow</Link></Button>
      </>} />
      <div className="p-3 sm:p-4">
        <div className="rounded-lg border">
          <Table>
            <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Categories</TableHead><TableHead>Version</TableHead><TableHead>Status</TableHead><TableHead>Launches</TableHead><TableHead>Updated</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
            <TableBody>
              {isLoading && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">Loading…</TableCell></TableRow>}
              {!isLoading && !flows.length && <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">No Flows yet. Create a form or sync existing Flows from Meta.</TableCell></TableRow>}
              {flows.map((flow) => {
                const status = flow.activeVersion?.status || "LOCAL";
                const editable = ["LOCAL", "DRAFT", "ERROR"].includes(status);
                return <TableRow key={flow.id}>
                  <TableCell data-label="Name"><div className="font-medium">{flow.name}</div><div className="text-[11px] text-muted-foreground">{flow.activeVersion?.metaFlowId || "Not pushed to Meta"}</div></TableCell>
                  <TableCell data-label="Categories"><div className="flex flex-wrap gap-1">{flow.categories.map((category) => <Badge key={category} variant="outline">{category.replaceAll("_", " ")}</Badge>)}</div></TableCell>
                  <TableCell data-label="Version">v{flow.activeVersion?.revision || 1}</TableCell>
                  <TableCell data-label="Status"><Badge variant={status === "PUBLISHED" ? "success" : status === "ERROR" || status === "BLOCKED" ? "destructive" : status === "DRAFT" ? "warning" : "secondary"}>{status}</Badge></TableCell>
                  <TableCell data-label="Launches">{flow._count.launches}</TableCell>
                  <TableCell data-label="Updated" className="text-xs text-muted-foreground">{formatDateTime(flow.updatedAt)}</TableCell>
                  <TableCell data-label="Actions"><div className="flex justify-end gap-0.5">
                    {editable && <Button variant="ghost" size="icon" title="Edit" asChild><Link href={`/flows/${flow.id}`}><Pencil className="h-4 w-4" /></Link></Button>}
                    {editable && <Button variant="ghost" size="icon" title="Upload and validate" onClick={() => action.mutate({ id: flow.id, name: "upload" })}><Upload className="h-4 w-4" /></Button>}
                    {editable && <Button variant="ghost" size="icon" title="Publish" onClick={() => confirm("Publishing is irreversible. Publish this Flow?") && action.mutate({ id: flow.id, name: "publish" })}><Send className="h-4 w-4 text-primary" /></Button>}
                    {status === "PUBLISHED" && <Button variant="ghost" size="icon" title="Clone to edit" onClick={() => action.mutate({ id: flow.id, name: "clone" })}><Copy className="h-4 w-4" /></Button>}
                    {status === "PUBLISHED" && <Button variant="ghost" size="icon" title="Deprecate" onClick={() => confirm("Deprecate this published Flow?") && action.mutate({ id: flow.id, name: "deprecate" })}><Archive className="h-4 w-4" /></Button>}
                    {flow.activeVersion?.previewUrl && <Button variant="ghost" size="icon" title="Meta preview" asChild><a href={flow.activeVersion.previewUrl} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /></a></Button>}
                    {!flow._count.launches && status !== "PUBLISHED" && <Button variant="ghost" size="icon" title="Delete" onClick={() => confirm(`Delete “${flow.name}”?`) && remove.mutate(flow.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>}
                  </div></TableCell>
                </TableRow>;
              })}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
