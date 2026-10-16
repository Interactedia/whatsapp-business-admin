"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, Eye, Pencil, Trash2, Send } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { formatDateTime } from "@/lib/utils";
import {
  componentsToBuilder,
  type ApiComponent,
  type TemplateCategory,
} from "@/lib/whatsapp/template-types";
import { TemplatePreview } from "@/components/whatsapp/template-preview";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { useI18n } from "@/components/i18n/language-provider";
type Template = {
  id: string;
  name: string;
  language: string;
  category: TemplateCategory;
  status: "LOCAL" | "PENDING" | "APPROVED" | "REJECTED" | "PAUSED" | "DISABLED";
  rejectionReason: string | null;
  metaTemplateId: string | null;
  components: ApiComponent[];
  updatedAt: string;
};

const STATUS_VARIANT: Record<Template["status"], BadgeProps["variant"]> = {
  LOCAL: "secondary",
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "destructive",
  PAUSED: "warning",
  DISABLED: "secondary",
};

export function TemplatesClient() {
  const tr = useI18n();
  const qc = useQueryClient();
  const pathname = usePathname();
  const { toast } = useToast();
  const [preview, setPreview] = useState<Template | null>(null);
  // ponytail: derive the active tenant from the URL so multi-tenant setups
  // sync against the right WABA without forcing the operator to pick.
  const activeTenantId = (() => {
    const m = pathname.match(/^\/t\/([^/]+)/);
    return m ? m[1] : null;
  })();

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["templates"],
    queryFn: () => apiFetch<Template[]>("/api/templates"),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["templates"] });

  const sync = useMutation({
    mutationFn: () =>
      apiFetch<{ synced: number }>("/api/templates/sync", {
        method: "POST",
        body: JSON.stringify(activeTenantId ? { tenantId: activeTenantId } : {}),
      }),
    onSuccess: (r) => {
      invalidate();
      toast({ title: tr.t("templates.syncSuccess").replace("{count}", String(r.synced)) });
    },
    onError: (e: Error) => toast({ variant: "destructive", title: tr.t("templates.syncError"), description: e.message }),
  });

  const submit = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/templates/${id}/submit`, { method: "POST" }),
    onSuccess: () => {
      invalidate();
      toast({ title: tr.t("templates.submitSuccess") });
    },
    onError: (e: Error) => toast({ variant: "destructive", title: tr.t("templates.submitError"), description: e.message }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/templates/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidate();
      toast({ title: tr.t("templates.deleteSuccess") });
    },
    onError: (e: Error) => toast({ variant: "destructive", title: tr.t("templates.deleteError"), description: e.message }),
  });

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={tr.t("templates.title")}
        description={tr.t("templates.description")}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => sync.mutate()} disabled={sync.isPending}>
              <RefreshCw className={`h-4 w-4 ${sync.isPending ? "animate-spin" : ""}`} /> {tr.t("templates.sync")}
            </Button>
            <Button size="sm" asChild>
              <Link href="/templates/new">
                <Plus className="h-4 w-4" /> {tr.t("templates.new")}
              </Link>
            </Button>
          </>
        }
      />

      <div className="p-3 sm:p-4">
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tr.t("templates.colName")}</TableHead>
                <TableHead className="w-24">{tr.t("templates.colLanguage")}</TableHead>
                <TableHead className="w-28">{tr.t("templates.colCategory")}</TableHead>
                <TableHead className="w-28">{tr.t("templates.colStatus")}</TableHead>
                <TableHead className="w-40">{tr.t("templates.colUpdated")}</TableHead>
                <TableHead className="w-36 text-right">{tr.t("templates.colActions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">{tr.t("templates.loading")}</TableCell>
                </TableRow>
              )}
              {!isLoading && templates.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    {tr.t("templates.emptyTitle")}. {tr.t("templates.emptyDescription")}
                  </TableCell>
                </TableRow>
              )}
              {templates.map((t) => {
                const editable = t.status === "LOCAL" || t.status === "REJECTED";
                return (
                  <TableRow key={t.id}>
                    <TableCell data-label={tr.t("templates.colName")} className="font-medium">
                      <div>{t.name}</div>
                      {t.rejectionReason && (
                        <div className="text-[11px] text-destructive">{t.rejectionReason}</div>
                      )}
                    </TableCell>
                    <TableCell data-label={tr.t("templates.colLanguage")} className="text-xs text-muted-foreground">{t.language}</TableCell>
                    <TableCell data-label={tr.t("templates.colCategory")}>
                      <Badge variant="outline">{t.category}</Badge>
                    </TableCell>
                    <TableCell data-label={tr.t("templates.colStatus")}>
                      <Badge variant={STATUS_VARIANT[t.status]}>{tr.t(`status.${t.status}`)}</Badge>
                    </TableCell>
                    <TableCell data-label={tr.t("templates.colUpdated")} className="text-xs text-muted-foreground">{formatDateTime(t.updatedAt)}</TableCell>
                    <TableCell data-label={tr.t("templates.colActions")} className="text-right">
                      <div className="flex justify-end gap-0.5">
                        <Button variant="ghost" size="icon" title={tr.t("templates.preview")} onClick={() => setPreview(t)}>
                          <Eye className="h-4 w-4" />
                        </Button>
                        {editable && (
                          <Button variant="ghost" size="icon" title={tr.t("templates.edit")} asChild>
                            <Link href={`/templates/${t.id}/edit`}>
                              <Pencil className="h-4 w-4" />
                            </Link>
                          </Button>
                        )}
                        {t.status === "LOCAL" && (
                          <Button variant="ghost" size="icon" title={tr.t("templates.submit")} onClick={() => submit.mutate(t.id)}>
                            <Send className="h-4 w-4 text-primary" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          title={tr.t("templates.delete")}
                          onClick={() => {
                            if (confirm(tr.t("templates.confirmDelete").replace("{name}", t.name))) remove.mutate(t.id);
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        {preview && (
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{preview.name}</DialogTitle>
            </DialogHeader>
            <TemplatePreview
              builder={componentsToBuilder(preview.components, {
                name: preview.name,
                language: preview.language,
                category: preview.category,
              })}
            />
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
