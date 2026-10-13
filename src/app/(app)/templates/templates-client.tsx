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
      toast({ title: `Synced ${r.synced} templates from Meta` });
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Sync failed", description: e.message }),
  });

  const submit = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/templates/${id}/submit`, { method: "POST" }),
    onSuccess: () => {
      invalidate();
      toast({ title: "Submitted for approval" });
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Submit failed", description: e.message }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/templates/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidate();
      toast({ title: "Template deleted" });
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Delete failed", description: e.message }),
  });

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Templates"
        description="Create, preview and submit WhatsApp message templates for Meta approval."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => sync.mutate()} disabled={sync.isPending}>
              <RefreshCw className={`h-4 w-4 ${sync.isPending ? "animate-spin" : ""}`} /> Sync
            </Button>
            <Button size="sm" asChild>
              <Link href="/templates/new">
                <Plus className="h-4 w-4" /> New template
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
                <TableHead>Name</TableHead>
                <TableHead className="w-24">Language</TableHead>
                <TableHead className="w-28">Category</TableHead>
                <TableHead className="w-28">Status</TableHead>
                <TableHead className="w-40">Updated</TableHead>
                <TableHead className="w-36 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">Loading…</TableCell>
                </TableRow>
              )}
              {!isLoading && templates.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    No templates yet. Click <span className="font-medium">New template</span> to create one.
                  </TableCell>
                </TableRow>
              )}
              {templates.map((t) => {
                const editable = t.status === "LOCAL" || t.status === "REJECTED";
                return (
                  <TableRow key={t.id}>
                    <TableCell data-label="Name" className="font-medium">
                      <div>{t.name}</div>
                      {t.rejectionReason && (
                        <div className="text-[11px] text-destructive">{t.rejectionReason}</div>
                      )}
                    </TableCell>
                    <TableCell data-label="Language" className="text-xs text-muted-foreground">{t.language}</TableCell>
                    <TableCell data-label="Category">
                      <Badge variant="outline">{t.category}</Badge>
                    </TableCell>
                    <TableCell data-label="Status">
                      <Badge variant={STATUS_VARIANT[t.status]}>{t.status}</Badge>
                    </TableCell>
                    <TableCell data-label="Updated" className="text-xs text-muted-foreground">{formatDateTime(t.updatedAt)}</TableCell>
                    <TableCell data-label="Actions" className="text-right">
                      <div className="flex justify-end gap-0.5">
                        <Button variant="ghost" size="icon" title="Preview" onClick={() => setPreview(t)}>
                          <Eye className="h-4 w-4" />
                        </Button>
                        {editable && (
                          <Button variant="ghost" size="icon" title="Edit" asChild>
                            <Link href={`/templates/${t.id}/edit`}>
                              <Pencil className="h-4 w-4" />
                            </Link>
                          </Button>
                        )}
                        {t.status === "LOCAL" && (
                          <Button variant="ghost" size="icon" title="Submit for approval" onClick={() => submit.mutate(t.id)}>
                            <Send className="h-4 w-4 text-primary" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Delete"
                          onClick={() => {
                            if (confirm(`Delete template "${t.name}"?`)) remove.mutate(t.id);
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
