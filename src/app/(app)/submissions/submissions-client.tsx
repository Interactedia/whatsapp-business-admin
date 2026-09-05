"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, RefreshCw, Search } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/shell/page-header";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

type Submission = {
  id: string;
  launchId: string;
  conversationId: string;
  flow: { id: string; name: string };
  contact: { waId: string; name: string | null; profileName: string | null };
  response: Record<string, unknown> | null;
  responseKeys: string[];
  purgedAt: string | null;
  completedAt: string;
  delivery: null | { status: string; attempt: number; error: string | null };
};

export function SubmissionsClient() {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Submission | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ["flow-submissions", search],
    queryFn: () => apiFetch<{ items: Submission[] }>(`/api/flow-submissions${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  });
  const retry = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/flow-submissions/${id}/retry`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flow-submissions"] });
      toast({ title: "Webhook delivery retried" });
    },
    onError: (error: Error) => toast({ variant: "destructive", title: "Retry failed", description: error.message }),
  });
  const items = data?.items || [];

  return <div className="flex h-full min-w-0 flex-col">
    <PageHeader title="Flow submissions" description="Search structured responses, review sensitive data safely, and monitor delivery." />
    <div className="space-y-3 p-3 sm:p-4">
      <div className="relative w-full sm:max-w-sm">
        <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search contact or WhatsApp number…" className="pl-8" />
      </div>
      <div className="rounded-lg border md:overflow-hidden">
        <Table>
          <TableHeader><TableRow><TableHead>Flow</TableHead><TableHead>Contact</TableHead><TableHead>Fields</TableHead><TableHead>Delivery</TableHead><TableHead>Completed</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
          <TableBody>
            {isLoading && <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">Loading…</TableCell></TableRow>}
            {!isLoading && !items.length && <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">No completed Flow submissions.</TableCell></TableRow>}
            {items.map((item) => <TableRow key={item.id}>
              <TableCell data-label="Flow" className="font-medium">{item.flow.name}</TableCell>
              <TableCell data-label="Contact"><div>{item.contact.name || item.contact.profileName || `+${item.contact.waId}`}</div><div className="text-[11px] text-muted-foreground">+{item.contact.waId}</div></TableCell>
              <TableCell data-label="Fields">{item.purgedAt ? <Badge variant="secondary">Purged</Badge> : <span className="wrap-break-word text-xs text-muted-foreground">{item.responseKeys.join(", ")}</span>}</TableCell>
              <TableCell data-label="Delivery">{item.delivery ? <Badge variant={item.delivery.status === "DELIVERED" ? "success" : item.delivery.status === "FAILED" ? "destructive" : "warning"}>{item.delivery.status}</Badge> : <span className="text-xs text-muted-foreground">Not configured</span>}</TableCell>
              <TableCell data-label="Completed" className="text-xs text-muted-foreground">{formatDateTime(item.completedAt)}</TableCell>
              <TableCell data-label="Actions"><div className="flex justify-end gap-1"><Button variant="ghost" size="icon" title="View" onClick={() => setSelected(item)}><Eye className="h-4 w-4" /></Button>{item.delivery?.status === "FAILED" && <Button variant="ghost" size="icon" title="Retry webhook" onClick={() => retry.mutate(item.id)}><RefreshCw className="h-4 w-4" /></Button>}</div></TableCell>
            </TableRow>)}
          </TableBody>
        </Table>
      </div>
    </div>
    <Dialog open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
      {selected && <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>{selected.flow.name}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between"><span>Completed {formatDateTime(selected.completedAt)}</span><Link href={`/inbox?c=${selected.conversationId}`} className="text-primary hover:underline">Open conversation</Link></div>
          {selected.response ? <dl className="divide-y rounded-md border">{Object.entries(selected.response).map(([key, value]) => <div key={key} className="grid grid-cols-1 gap-1 p-2 text-sm sm:grid-cols-[150px_1fr] sm:gap-3"><dt className="font-medium">{key}</dt><dd className="wrap-break-word text-muted-foreground">{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd></div>)}</dl> : <div className="rounded-sm border p-4 text-sm text-muted-foreground">Response data was purged under this Flow’s retention policy.</div>}
        </div>
      </DialogContent>}
    </Dialog>
  </div>;
}
