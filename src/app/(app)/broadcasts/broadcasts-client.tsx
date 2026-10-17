"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Megaphone } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { useI18n } from "@/components/i18n/language-provider";

type Broadcast = {
  id: string;
  name: string;
  templateName: string;
  status: "DRAFT" | "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  total: number;
  sentCount: number;
  failedCount: number;
  createdAt: string;
};

const STATUS_VARIANT: Record<Broadcast["status"], BadgeProps["variant"]> = {
  DRAFT: "secondary",
  QUEUED: "warning",
  RUNNING: "warning",
  COMPLETED: "success",
  FAILED: "destructive",
  CANCELLED: "secondary",
};

export function BroadcastsClient() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { t } = useI18n();

  const { data: broadcasts = [] } = useQuery({
    queryKey: ["broadcasts"],
    queryFn: () => apiFetch<Broadcast[]>("/api/broadcasts"),
    refetchInterval: 4000,
  });

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t("broadcasts.title")}
        description={t("broadcasts.description")}
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4" /> {t("broadcasts.new")}
              </Button>
            </DialogTrigger>
            <NewBroadcastDialog onClose={() => setOpen(false)} onCreated={() => qc.invalidateQueries({ queryKey: ["broadcasts"] })} />
          </Dialog>
        }
      />

      <div className="p-3 sm:p-4">
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("broadcasts.colName")}</TableHead>
                <TableHead className="w-40">{t("broadcasts.colTemplate")}</TableHead>
                <TableHead className="w-28">{t("broadcasts.colStatus")}</TableHead>
                <TableHead className="w-56">{t("broadcasts.colProgress")}</TableHead>
                <TableHead className="w-40">{t("broadcasts.colCreated")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {broadcasts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    <Megaphone className="mx-auto mb-1 h-6 w-6 opacity-40" />
                    {t("broadcasts.empty")}
                  </TableCell>
                </TableRow>
              )}
              {broadcasts.map((b) => {
                const done = b.sentCount + b.failedCount;
                const pct = b.total ? Math.round((done / b.total) * 100) : 0;
                return (
                  <TableRow key={b.id}>
                    <TableCell data-label="Name" className="font-medium">{b.name}</TableCell>
                    <TableCell data-label="Template" className="text-xs text-muted-foreground">{b.templateName}</TableCell>
                    <TableCell data-label="Status">
                      <Badge variant={STATUS_VARIANT[b.status]} title={b.status}>{t("broadcasts.status." + b.status as keyof typeof STATUS_VARIANT)}</Badge>
                    </TableCell>
                    <TableCell data-label="Progress">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {b.sentCount}✓ {b.failedCount > 0 && <span className="text-destructive">{b.failedCount}✗</span>} / {b.total}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell data-label="Created" className="text-xs text-muted-foreground">{formatDateTime(b.createdAt)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

type ApprovedTemplate = { id: string; name: string; language: string; status: string };

function NewBroadcastDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { toast } = useToast();
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [audienceType, setAudienceType] = useState<"all" | "tag">("all");
  const [tag, setTag] = useState("");

  const { data: templates = [] } = useQuery({
    queryKey: ["templates", "approved"],
    queryFn: () => apiFetch<ApprovedTemplate[]>("/api/templates?approved=true"),
  });

  const create = useMutation({
    mutationFn: () =>
      apiFetch<{ total: number }>("/api/broadcasts", {
        method: "POST",
        body: JSON.stringify({
          name,
          templateId,
          audience: audienceType === "all" ? { type: "all" } : { type: "tag", tag },
        }),
      }),
    onSuccess: (r) => {
      toast({ title: t("broadcasts.success"), description: t("broadcasts.successRecipients").replace("{count}", String(r.total)) });
      onCreated();
      onClose();
    },
    onError: (e: Error) => toast({ variant: "destructive", title: t("broadcasts.error"), description: e.message }),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t("broadcasts.dialogTitle")}</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1">
          <Label>{t("broadcasts.labelName")}</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("broadcasts.placeholderName")} />
        </div>
        <div className="space-y-1">
          <Label>{t("broadcasts.labelTemplate")}</Label>
          <Select value={templateId} onValueChange={setTemplateId}>
            <SelectTrigger>
              <SelectValue placeholder={templates.length ? t("broadcasts.placeholderTemplate") : t("broadcasts.placeholderTemplateEmpty")} />
            </SelectTrigger>
            <SelectContent>
              {templates.map((tmpl) => (
                <SelectItem key={tmpl.id} value={tmpl.id}>
                  {tmpl.name} ({tmpl.language})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>{t("broadcasts.labelAudience")}</Label>
          <Select value={audienceType} onValueChange={(v) => setAudienceType(v as "all" | "tag")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("broadcasts.audienceAll")}</SelectItem>
              <SelectItem value="tag">{t("broadcasts.audienceTag")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {audienceType === "tag" && (
          <div className="space-y-1">
            <Label>{t("broadcasts.labelTag")}</Label>
            <Input value={tag} onChange={(e) => setTag(e.target.value)} placeholder={t("broadcasts.placeholderTag")} />
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">{t("broadcasts.disclaimer")}</p>
      </div>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>{t("broadcasts.cancel")}</Button>
        <Button
          size="sm"
          disabled={!name || !templateId || (audienceType === "tag" && !tag) || create.isPending}
          onClick={() => create.mutate()}
        >
          {t("broadcasts.start")}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
