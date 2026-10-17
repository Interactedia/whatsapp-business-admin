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
import { useI18n } from "@/components/i18n/language-provider";

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
  const { t } = useI18n();
  const activeTenantId = pathname.match(/^\/t\/([^/]+)/)?.[1] ?? null;
  const { data: flows = [], isLoading } = useQuery({ queryKey: ["flows"], queryFn: () => apiFetch<FlowRow[]>("/api/flows") });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["flows"] });
  const action = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => apiFetch(`/api/flows/${id}/${name}`, { method: "POST" }),
    onSuccess: (_r, variables) => { invalidate(); toast({ title: t("flows.actionSuccess").replace("{name}", variables.name) }); },
    onError: (error: Error) => toast({ variant: "destructive", title: t("flows.actionError"), description: error.message }),
  });
  const sync = useMutation({
    mutationFn: () => apiFetch<{ synced: number }>("/api/flows/sync", { method: "POST", body: JSON.stringify(activeTenantId ? { tenantId: activeTenantId } : {}) }),
    onSuccess: (result) => { invalidate(); toast({ title: t("flows.syncSuccess").replace("{count}", String(result.synced)) }); },
    onError: (error: Error) => toast({ variant: "destructive", title: t("flows.syncError"), description: error.message }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/flows/${id}`, { method: "DELETE" }),
    onSuccess: () => { invalidate(); toast({ title: t("flows.deleteSuccess") }); },
    onError: (error: Error) => toast({ variant: "destructive", title: t("flows.deleteError"), description: error.message }),
  });

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t("flows.title")} description={t("flows.description")} actions={<>
        <Button variant="outline" size="sm" onClick={() => sync.mutate()} disabled={sync.isPending}><RefreshCw className={sync.isPending ? "h-4 w-4 animate-spin" : "h-4 w-4"} /> {t("flows.sync")}</Button>
        <Button size="sm" asChild><Link href="/flows/new"><Plus className="h-4 w-4" /> {t("flows.new")}</Link></Button>
      </>} />
      <div className="p-3 sm:p-4">
        <div className="rounded-lg border">
          <Table>
            <TableHeader><TableRow><TableHead>{t("flows.colName")}</TableHead><TableHead>{t("flows.colCategories")}</TableHead><TableHead>{t("flows.colVersion")}</TableHead><TableHead>{t("flows.colStatus")}</TableHead><TableHead>{t("flows.colLaunches")}</TableHead><TableHead>{t("flows.colUpdated")}</TableHead><TableHead className="text-right">{t("flows.colActions")}</TableHead></TableRow></TableHeader>
            <TableBody>
              {isLoading && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">{t("flows.loading")}</TableCell></TableRow>}
              {!isLoading && !flows.length && <TableRow><TableCell colSpan={7} className="py-10 text-center"><div className="font-medium">{t("flows.emptyTitle")}</div><div className="text-xs text-muted-foreground">{t("flows.emptyDescription")}</div></TableCell></TableRow>}
              {flows.map((flow) => {
                const status = flow.activeVersion?.status || "LOCAL";
                const editable = ["LOCAL", "DRAFT", "ERROR"].includes(status);
                const statusKey = `flowStatus.${status}`;
                return <TableRow key={flow.id}>
                  <TableCell data-label={t("flows.colName")}><div className="font-medium">{flow.name}</div><div className="text-[11px] text-muted-foreground">{flow.activeVersion?.metaFlowId || t("flows.notPushed")}</div></TableCell>
                  <TableCell data-label={t("flows.colCategories")}><div className="flex flex-wrap gap-1">{flow.categories.map((category) => <Badge key={category} variant="outline">{category.replaceAll("_", " ")}</Badge>)}</div></TableCell>
                  <TableCell data-label={t("flows.colVersion")}>v{flow.activeVersion?.revision || 1}</TableCell>
                  <TableCell data-label={t("flows.colStatus")}><Badge variant={status === "PUBLISHED" ? "success" : status === "ERROR" || status === "BLOCKED" ? "destructive" : status === "DRAFT" ? "warning" : "secondary"}>{t(statusKey, status)}</Badge></TableCell>
                  <TableCell data-label={t("flows.colLaunches")}>{flow._count.launches}</TableCell>
                  <TableCell data-label={t("flows.colUpdated")} className="text-xs text-muted-foreground">{formatDateTime(flow.updatedAt)}</TableCell>
                  <TableCell data-label={t("flows.colActions")}><div className="flex justify-end gap-0.5">
                    {editable && <Button variant="ghost" size="icon" title={t("flows.actionEdit")} asChild><Link href={`/flows/${flow.id}`}><Pencil className="h-4 w-4" /></Link></Button>}
                    {editable && <Button variant="ghost" size="icon" title={t("flows.actionUpload")} onClick={() => action.mutate({ id: flow.id, name: "upload" })}><Upload className="h-4 w-4" /></Button>}
                    {editable && <Button variant="ghost" size="icon" title={t("flows.actionPublish")} onClick={() => confirm(t("flows.confirmPublish")) && action.mutate({ id: flow.id, name: "publish" })}><Send className="h-4 w-4 text-primary" /></Button>}
                    {status === "PUBLISHED" && <Button variant="ghost" size="icon" title={t("flows.actionClone")} onClick={() => action.mutate({ id: flow.id, name: "clone" })}><Copy className="h-4 w-4" /></Button>}
                    {status === "PUBLISHED" && <Button variant="ghost" size="icon" title={t("flows.actionDeprecate")} onClick={() => confirm(t("flows.confirmDeprecate")) && action.mutate({ id: flow.id, name: "deprecate" })}><Archive className="h-4 w-4" /></Button>}
                    {flow.activeVersion?.previewUrl && <Button variant="ghost" size="icon" title={t("flows.actionMetaPreview")} asChild><a href={flow.activeVersion.previewUrl} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /></a></Button>}
                    {!flow._count.launches && status !== "PUBLISHED" && <Button variant="ghost" size="icon" title={t("flows.actionDelete")} onClick={() => confirm(t("flows.confirmDelete").replace("{name}", flow.name)) && remove.mutate(flow.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>}
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
