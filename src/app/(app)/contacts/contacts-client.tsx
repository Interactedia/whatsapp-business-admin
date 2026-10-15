"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, MessageSquare, Search, Pencil, Users } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { SmartTagsCombobox } from "@/components/ui/smart-tags-combobox";

// Tag colors consistent with Inbox (WA-UI-014 pattern)
const TAG_COLORS = [
  "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
  "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300",
  "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300",
  "bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-300",
];

function tagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  }
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

function displayName(c: Contact): string {
  return c.name || c.profileName || `+${c.waId}`;
}

function initials(c: Contact): string {
  return displayName(c).replace("+", "").slice(0, 2).toUpperCase();
}

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

  // Extract all unique tags from loaded contacts for suggestions
  const allTags = [...new Set(contacts.flatMap((c) => c.tags ?? []))].sort();

  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`${baseUrl}/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidate();
      toast({ title: "Contacto eliminado" });
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Error al eliminar", description: e.message }),
  });

  const startChat = useMutation({
    mutationFn: (c: Contact) =>
      apiFetch<{ id: string }>(`/api/tenants/${tenantId}/conversations`, {
        method: "POST",
        body: JSON.stringify({ waId: c.waId, name: c.name ?? undefined }),
      }),
    onSuccess: (conv) => router.push(`${conversationsHref}?c=${conv.id}`),
    onError: (e: Error) => toast({ variant: "destructive", title: "No se puede iniciar conversación", description: e.message }),
  });

  return (
    <div className="flex h-full flex-col">
      {/* Scope A: Estandarizado PageHeader en español */}
      <PageHeader
        title="Contactos"
        description="Administra tus contactos y sus conversaciones."
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="bg-teal-600 hover:bg-teal-700 text-white">
                <Plus className="h-4 w-4" /> Nuevo contacto
              </Button>
            </DialogTrigger>
            <ContactDialog onClose={() => setOpen(false)} onSaved={invalidate} baseUrl={baseUrl} allTags={allTags} />
          </Dialog>
        }
      />

      {/* Content area - padding uniforme como Users */}
      <div className="flex-1 overflow-auto p-4 sm:p-6">
        {/* Table container - borde y fondo como Users */}
        <div className="rounded-lg border bg-card">
          {/* Scope B: Toolbar compacta con buscador y contador */}
          <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-xs">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-8 pl-9 text-sm"
                placeholder="Buscar por nombre o teléfono..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {!isLoading && contacts.length > 0 && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Users className="h-3.5 w-3.5" />
                <span>{contacts.length} contacto{contacts.length !== 1 ? "s" : ""}</span>
              </div>
            )}
          </div>

          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Contacto</TableHead>
                <TableHead className="hidden sm:table-cell w-36">Teléfono</TableHead>
                <TableHead className="hidden md:table-cell">Etiquetas</TableHead>
                <TableHead className="w-28 pr-4 text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* Scope E: Empty States */}
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={4} className="h-48 text-center text-muted-foreground">
                    <div className="flex flex-col items-center gap-2">
                      <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                      <span className="text-sm">Cargando contactos...</span>
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && contacts.length === 0 && !search && (
                <TableRow>
                  <TableCell colSpan={4} className="h-48 text-center">
                    <div className="flex flex-col items-center gap-3 py-8">
                      <div className="rounded-full bg-muted p-3">
                        <Users className="h-6 w-6 text-muted-foreground" />
                      </div>
                      <div>
                        <p className="font-medium text-foreground">Sin contactos</p>
                        <p className="mt-1 text-sm text-muted-foreground">Agrega tu primer contacto con el botón de arriba.</p>
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && contacts.length === 0 && search && (
                <TableRow>
                  <TableCell colSpan={4} className="h-48 text-center">
                    <div className="flex flex-col items-center gap-3 py-8">
                      <div className="rounded-full bg-muted p-3">
                        <Search className="h-6 w-6 text-muted-foreground" />
                      </div>
                      <div>
                        <p className="font-medium text-foreground">Sin resultados</p>
                        <p className="mt-1 text-sm text-muted-foreground">No se encontraron contactos para &ldquo;{search}&rdquo;.</p>
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {/* Scope C: Contact rows con avatares y tags coloreados */}
              {contacts.map((c) => {
                const visibleTags = c.tags.slice(0, 2);
                const extraTags = c.tags.length - 2;
                return (
                  <TableRow key={c.id} className="group">
                    {/* Columna: Contacto con avatar */}
                    <TableCell className="pl-4">
                      <div className="flex items-center gap-3">
                        <Avatar className="h-8 w-8">
                          <AvatarFallback className="text-xs">{initials(c)}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-sm text-foreground">
                            {c.name || c.profileName || <span className="text-muted-foreground">Desconocido</span>}
                          </p>
                          {/* Teléfono visible en mobile */}
                          <p className="mt-0.5 font-mono text-xs text-muted-foreground sm:hidden">+{c.waId}</p>
                        </div>
                      </div>
                    </TableCell>
                    {/* Columna: Teléfono (hidden on mobile) */}
                    <TableCell className="hidden sm:table-cell">
                      <span className="font-mono text-xs text-muted-foreground">+{c.waId}</span>
                    </TableCell>
                    {/* Columna: Etiquetas (hidden on small tablets) */}
                    <TableCell className="hidden md:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {visibleTags.map((tag) => (
                          <span
                            key={tag}
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${tagColor(tag)}`}
                          >
                            {tag}
                          </span>
                        ))}
                        {extraTags > 0 && (
                          <span className="inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            +{extraTags}
                          </span>
                        )}
                        {c.tags.length === 0 && (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                    {/* Columna: Acciones */}
                    <TableCell className="pr-4">
                      {/* Scope D: Acciones con tooltips accesibles */}
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          title="Abrir conversación"
                          onClick={() => startChat.mutate(c)}
                        >
                          <MessageSquare className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          title="Editar contacto"
                          onClick={() => setEdit(c)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        {isAdmin && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            title="Eliminar contacto"
                            onClick={() => {
                              if (confirm("¿Eliminar este contacto?")) remove.mutate(c.id);
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        {edit && <ContactDialog contact={edit} onClose={() => setEdit(null)} onSaved={invalidate} baseUrl={baseUrl} allTags={allTags} />}
      </Dialog>
    </div>
  );
}

function ContactDialog({ contact, onClose, onSaved, baseUrl, allTags }: { contact?: Contact; onClose: () => void; onSaved: () => void; baseUrl: string; allTags: string[] }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    waId: contact?.waId ?? "",
    name: contact?.name ?? "",
    tags: contact?.tags ?? [],
    notes: contact?.notes ?? "",
  });

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name || undefined,
        tags: form.tags,
        notes: form.notes || undefined,
      };
      return contact
        ? apiFetch(`${baseUrl}/${contact.id}`, { method: "PATCH", body: JSON.stringify(payload) })
        : apiFetch(baseUrl, { method: "POST", body: JSON.stringify({ waId: form.waId, ...payload }) });
    },
    onSuccess: () => {
      toast({ title: contact ? "Contacto actualizado" : "Contacto agregado" });
      onSaved();
      onClose();
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "No se pudo guardar", description: e.message }),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{contact ? "Editar contacto" : "Nuevo contacto"}</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1">
          <Label>Número de WhatsApp (solo dígitos, sin +)</Label>
          <Input
            value={form.waId}
            onChange={(e) => setForm({ ...form, waId: e.target.value.replace(/\D/g, "") })}
            placeholder="51912345678"
            disabled={!!contact}
          />
        </div>
        <div className="space-y-1">
          <Label>Nombre</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label>Etiquetas</Label>
          <SmartTagsCombobox
            value={form.tags}
            onChange={(tags) => setForm({ ...form, tags })}
            suggestions={allTags}
            placeholder="Buscar o crear etiqueta..."
          />
        </div>
        <div className="space-y-1">
          <Label>Notas</Label>
          <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>Cancelar</Button>
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>Guardar</Button>
      </DialogFooter>
    </DialogContent>
  );
}
