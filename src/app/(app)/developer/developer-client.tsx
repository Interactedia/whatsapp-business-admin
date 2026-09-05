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
import { ApiDocs } from "./api-docs";

type ApiKey = { id: string; name: string; keyPrefix: string; lastUsedAt: string | null; createdAt: string };

export function DeveloperClient({ baseUrl }: { baseUrl: string }) {
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="API" description="Programmatic access to send messages, templates and broadcasts." />
      <div className="min-h-0 flex-1 overflow-auto p-3 scroll-thin sm:p-4">
        <Tabs defaultValue="keys">
          <TabsList>
            <TabsTrigger value="keys">API Keys</TabsTrigger>
            <TabsTrigger value="docs">Documentation</TabsTrigger>
          </TabsList>
          <TabsContent value="keys">
            <ApiKeys />
          </TabsContent>
          <TabsContent value="docs">
            <ApiDocs baseUrl={baseUrl} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function ApiKeys() {
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
      toast({ title: "API key revoked" });
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Revoke failed", description: e.message }),
  });

  return (
    <div className="max-w-3xl space-y-3">
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          Use these keys to authenticate requests to <code className="rounded-sm bg-muted px-1">/api/v1</code>.
          Keep them secret — treat a key like a password.
        </p>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="h-4 w-4" /> New key
            </Button>
          </DialogTrigger>
          <CreateKeyDialog
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
              <TableHead>Name</TableHead>
              <TableHead className="w-56">Key</TableHead>
              <TableHead className="w-40">Last used</TableHead>
              <TableHead className="w-40">Created</TableHead>
              <TableHead className="w-16 text-right">Revoke</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">Loading…</TableCell>
              </TableRow>
            )}
            {!isLoading && keys.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  <KeyRound className="mx-auto mb-1 h-6 w-6 opacity-40" />
                  No API keys yet.
                </TableCell>
              </TableRow>
            )}
            {keys.map((k) => (
              <TableRow key={k.id}>
                <TableCell data-label="Name" className="font-medium">{k.name}</TableCell>
                <TableCell data-label="Key" className="break-all font-mono text-xs text-muted-foreground">{k.keyPrefix}</TableCell>
                <TableCell data-label="Last used" className="text-xs text-muted-foreground">
                  {k.lastUsedAt ? formatDateTime(k.lastUsedAt) : "never"}
                </TableCell>
                <TableCell data-label="Created" className="text-xs text-muted-foreground">{formatDateTime(k.createdAt)}</TableCell>
                <TableCell data-label="Revoke" className="text-right">
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Revoke"
                    onClick={() => {
                      if (confirm(`Revoke "${k.name}"? Any integration using it will stop working.`)) revoke.mutate(k.id);
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

function CreateKeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (v: { name: string; key: string }) => void }) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => apiFetch<{ name: string; key: string }>("/api/apikeys", { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: (r) => onCreated({ name: r.name, key: r.key }),
    onError: (e: Error) => toast({ variant: "destructive", title: "Could not create key", description: e.message }),
  });
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>New API key</DialogTitle>
        <DialogDescription>Give it a name so you can recognise it later.</DialogDescription>
      </DialogHeader>
      <div className="space-y-1">
        <Label>Name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Production server" />
      </div>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>Create key</Button>
      </DialogFooter>
    </DialogContent>
  );
}

function RevealKeyDialog({ name, apiKey, onClose }: { name: string; apiKey: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>API key created</DialogTitle>
        <DialogDescription>“{name}”</DialogDescription>
      </DialogHeader>
      <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-300">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        Copy this key now — it won’t be shown again. Store it somewhere secure.
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs">{apiKey}</code>
        <Button
          size="icon"
          variant="outline"
          onClick={() => {
            navigator.clipboard.writeText(apiKey);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
      <DialogFooter>
        <Button size="sm" onClick={onClose}>Done</Button>
      </DialogFooter>
    </DialogContent>
  );
}
