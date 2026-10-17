"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Copy, Check, KeyRound, ShieldAlert } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { useI18n } from "@/components/i18n/language-provider";
import { ApiDocs } from "./api-docs";

type TenantOption = { id: string; name: string };
type ApiKey = { id: string; name: string; keyPrefix: string; lastUsedAt: string | null; createdAt: string; tenantId: string | null };

export function DeveloperClient({ baseUrl, tenants }: { baseUrl: string; tenants: TenantOption[] }) {
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t("developer.title")} description={t("developer.description")} />
      <div className="min-h-0 flex-1 overflow-auto p-3 scroll-thin sm:p-4">
        <Tabs defaultValue="keys">
          <TabsList>
            <TabsTrigger value="keys">{t("developer.tabKeys")}</TabsTrigger>
            <TabsTrigger value="docs">{t("developer.tabDocs")}</TabsTrigger>
          </TabsList>
          <TabsContent value="keys">
            <ApiKeys tenants={tenants} />
          </TabsContent>
          <TabsContent value="docs">
            <ApiDocs baseUrl={baseUrl} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function ApiKeys({ tenants }: { tenants: TenantOption[] }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);

  const { data: keys = [], isLoading } = useQuery({
    queryKey: ["apikeys"],
    queryFn: () => apiFetch<ApiKey[]>("/api/apikeys"),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["apikeys"] });

  const revoke = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/apikeys/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidate();
      toast({ title: t("developer.revoke.success") });
    },
    onError: (e: Error) => toast({ variant: "destructive", title: t("developer.revoke.error"), description: e.message }),
  });

  return (
    <div className="max-w-3xl space-y-3">
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          {t("developer.keys.info")}
        </p>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="h-4 w-4" /> {t("developer.createKey")}
            </Button>
          </DialogTrigger>
          <CreateKeyDialog
            tenants={tenants}
            onClose={() => setOpen(false)}
            onCreated={(v) => {
              invalidate();
              setCreated(v);
              setOpen(false);
            }}
          />
        </Dialog>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("developer.colName")}</TableHead>
              <TableHead className="w-56">{t("developer.colPrefix")}</TableHead>
              <TableHead className="w-40">{t("developer.colLastUsed")}</TableHead>
              <TableHead className="w-40">{t("developer.colCreated")}</TableHead>
              <TableHead className="w-16 text-right">{t("developer.colActions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">{t("developer.loading")}</TableCell>
              </TableRow>
            )}
            {!isLoading && keys.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  <KeyRound className="mx-auto mb-1 h-6 w-6 opacity-40" />
                  {t("developer.emptyTitle")}
                </TableCell>
              </TableRow>
            )}
            {keys.map((k) => (
              <TableRow key={k.id}>
                <TableCell data-label={t("developer.colName")} className="font-medium">{k.name}</TableCell>
                <TableCell data-label={t("developer.colPrefix")} className="break-all font-mono text-xs text-muted-foreground">{k.keyPrefix}</TableCell>
                <TableCell data-label={t("developer.colLastUsed")} className="text-xs text-muted-foreground">
                  {k.lastUsedAt ? formatDateTime(k.lastUsedAt) : t("developer.neverUsed")}
                </TableCell>
                <TableCell data-label={t("developer.colCreated")} className="text-xs text-muted-foreground">{formatDateTime(k.createdAt)}</TableCell>
                <TableCell data-label={t("developer.colActions")} className="text-right">
                  <Button
                    variant="ghost"
                    size="icon"
                    title={t("developer.revoke.action")}
                    onClick={() => {
                      if (confirm(t("developer.revoke.confirm").replace("{name}", `"${k.name}"?`))) revoke.mutate(k.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!created} onOpenChange={(o) => !o && setCreated(null)}>
        {created && <RevealKeyDialog name={created.name} apiKey={created.key} onClose={() => setCreated(null)} />}
      </Dialog>
    </div>
  );
}

function CreateKeyDialog({
  tenants,
  onClose,
  onCreated,
}: {
  tenants: TenantOption[];
  onClose: () => void;
  onCreated: (v: { name: string; key: string }) => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [tenantId, setTenantId] = useState(tenants[0]?.id ?? "");
  const create = useMutation({
    mutationFn: () => apiFetch<{ name: string; key: string }>("/api/apikeys", { method: "POST", body: JSON.stringify({ name, tenantId }) }),
    onSuccess: (r) => onCreated({ name: r.name, key: r.key }),
    onError: (e: Error) => toast({ variant: "destructive", title: t("developer.create.error"), description: e.message }),
  });
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t("developer.createDialog.title")}</DialogTitle>
        <DialogDescription>{t("developer.createDialog.hint")}</DialogDescription>
      </DialogHeader>
      <div className="space-y-1">
        <Label>{t("developer.createDialog.nameLabel")}</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("developer.createDialog.namePlaceholder")} />
      </div>
      <div className="space-y-1">
        <Label>{t("developer.createDialog.tenantLabel")}</Label>
        <select
          className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
          disabled={tenants.length === 0}
        >
          {tenants.map((tenant) => (
            <option key={tenant.id} value={tenant.id}>{tenant.name}</option>
          ))}
        </select>
      </div>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>{t("developer.createDialog.cancel")}</Button>
        <Button size="sm" disabled={!name.trim() || !tenantId || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? t("developer.createDialog.creating") : t("developer.createDialog.create")}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function RevealKeyDialog({ name, apiKey, onClose }: { name: string; apiKey: string; onClose: () => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t("developer.revealDialog.title")}</DialogTitle>
        <DialogDescription>&ldquo;{name}&rdquo;</DialogDescription>
      </DialogHeader>
      <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-300">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        {t("developer.revealDialog.warning")}
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs">{apiKey}</code>
        <Button
          size="icon"
          variant="outline"
          onClick={() => {
            navigator.clipboard.writeText(apiKey);
            setCopied(true);
          }}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
      <DialogFooter>
        <Button size="sm" onClick={onClose}>{t("developer.revealDialog.done")}</Button>
      </DialogFooter>
    </DialogContent>
  );
}
