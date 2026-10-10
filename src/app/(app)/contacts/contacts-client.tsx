"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, MessageSquare, Search, Pencil } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

type Contact = {
  id: string;
  waId: string;
  name: string | null;
  profileName: string | null;
  tags: string[];
  notes: string | null;
  conversation: { id: string } | null;
};

export function ContactsClient({
  isAdmin,
  baseUrl,
  conversationsHref,
}: {
  isAdmin: boolean;
  /**
   * Tenant-scoped base URL for all contact operations.
   * Example: `/api/tenants/${tenantId}/contacts`
   * POST creates at this URL, PATCH/DELETE at `${baseUrl}/${id}`.
   */
  baseUrl: string;
  /** Canonical tenant conversations page for "start chat" navigation. */
  conversationsHref: string;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<Contact | null>(null);

  const listUrl = baseUrl;
  // Derive tenantId from the conversationsHref path (/t/:tenantId/conversations).
  const tenantId = conversationsHref.startsWith("/t/") ? conversationsHref.split("/")[2] : "";
  const { data: contacts = [], isLoading } = useQuery({
    queryKey: [listUrl, search],
    queryFn: () =>
      apiFetch<Contact[]>(
        `${listUrl}${search ? `?search=${encodeURIComponent(search)}` : ""}`
      ),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: [listUrl] });

  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`${baseUrl}/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidate();
      toast({ title: "Contact deleted" });
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Delete failed", description: e.message }),
  });

  const startChat = useMutation({
    mutationFn: (c: Contact) =>
      apiFetch<{ id: string }>(`/api/tenants/${tenantId}/conversations`, {
        method: "POST",
        body: JSON.stringify({ waId: c.waId, name: c.name ?? undefined }),
      }),
    onSuccess: (conv) => router.push(`${conversationsHref}?c=${conv.id}`),
  });

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Contacts"
        description="Everyone who has messaged you, plus contacts you add."
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4" /> New contact
              </Button>
            </DialogTrigger>
            <ContactDialog onClose={() => setOpen(false)} onSaved={invalidate} baseUrl={baseUrl} />
          </Dialog>
        }
      />

      <div className="p-3 sm:p-4">
        <div className="relative mb-3 w-full sm:max-w-xs">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search name or number…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>

        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="w-40">Number</TableHead>
                <TableHead>Tags</TableHead>
                <TableHead className="w-32 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">Loading…</TableCell>
                </TableRow>
              )}
              {!isLoading && contacts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">No contacts yet.</TableCell>
                </TableRow>
              )}
              {contacts.map((c) => (
                <TableRow key={c.id}>
                  <TableCell data-label="Name" className="font-medium">
                    {c.name || c.profileName || <span className="text-muted-foreground">Unknown</span>}
                  </TableCell>
                  <TableCell data-label="Number" className="font-mono text-xs text-muted-foreground">+{c.waId}</TableCell>
                  <TableCell data-label="Tags">
                    <div className="flex flex-wrap gap-1">
                      {c.tags.map((t) => (
                        <Badge key={t} variant="secondary">{t}</Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell data-label="Actions" className="text-right">
                    <div className="flex justify-end gap-0.5">
                      <Button variant="ghost" size="icon" title="Open chat" onClick={() => startChat.mutate(c)}>
                        <MessageSquare className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" title="Edit" onClick={() => setEdit(c)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      {isAdmin && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Delete"
                          onClick={() => {
                            if (confirm("Delete this contact?")) remove.mutate(c.id);
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        {edit && <ContactDialog contact={edit} onClose={() => setEdit(null)} onSaved={invalidate} baseUrl={baseUrl} />}
      </Dialog>
    </div>
  );
}

function ContactDialog({ contact, onClose, onSaved, baseUrl }: { contact?: Contact; onClose: () => void; onSaved: () => void; baseUrl: string }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    waId: contact?.waId ?? "",
    name: contact?.name ?? "",
    tags: (contact?.tags ?? []).join(", "),
    notes: contact?.notes ?? "",
  });

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name || undefined,
        tags: form.tags.split(",").map((s) => s.trim()).filter(Boolean),
        notes: form.notes || undefined,
      };
      return contact
        ? apiFetch(`${baseUrl}/${contact.id}`, { method: "PATCH", body: JSON.stringify(payload) })
        : apiFetch(baseUrl, { method: "POST", body: JSON.stringify({ waId: form.waId, ...payload }) });
    },
    onSuccess: () => {
      toast({ title: contact ? "Contact updated" : "Contact added" });
      onSaved();
      onClose();
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Could not save", description: e.message }),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{contact ? "Edit contact" : "New contact"}</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1">
          <Label>WhatsApp number (digits only, no +)</Label>
          <Input
            value={form.waId}
            onChange={(e) => setForm({ ...form, waId: e.target.value.replace(/\D/g, "") })}
            placeholder="919812345678"
            disabled={!!contact}
          />
        </div>
        <div className="space-y-1">
          <Label>Name</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label>Tags (comma separated)</Label>
          <Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="vip, lead" />
        </div>
        <div className="space-y-1">
          <Label>Notes</Label>
          <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>
      </DialogFooter>
    </DialogContent>
  );
}
