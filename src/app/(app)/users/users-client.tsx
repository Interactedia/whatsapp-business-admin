"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, KeyRound, UserPlus, Check } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";

type User = {
  id: string;
  name: string;
  email: string;
  role: "SYSTEM_ADMIN" | "ADMIN" | "AGENT";
  active: boolean;
  createdAt: string;
};

type TenantMember = {
  id: string;
  userId: string;
  tenantId: string;
  createdAt: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: "SYSTEM_ADMIN" | "ADMIN" | "AGENT";
    active: boolean;
  };
};

export function UsersClient({
  currentUserId,
  currentRole,
  tenantId,
  tenantName,
}: {
  currentUserId: string;
  currentRole?: "SYSTEM_ADMIN" | "ADMIN" | "AGENT";
  tenantId?: string;
  tenantName?: string;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [resetFor, setResetFor] = useState<User | null>(null);
  const [deleteFor, setDeleteFor] = useState<User | null>(null);

  // Only a SYSTEM_ADMIN may grant/revoke the SYSTEM_ADMIN role or modify
  // existing SYSTEM_ADMIN accounts (mirrors the server-side check in
  // /api/users/[id]).
  const canManageSystemAdmins = currentRole === "SYSTEM_ADMIN";

  const { data: users = [], isLoading } = useQuery({
    queryKey: ["users"],
    queryFn: () => apiFetch<User[]>("/api/users"),
  });

  const { data: tenantMembers = [] } = useQuery({
    queryKey: ["tenants", tenantId, "memberships"],
    queryFn: () => apiFetch<TenantMember[]>(`/api/tenants/${tenantId}/memberships`),
    enabled: Boolean(tenantId),
  });

  const memberUserIds = new Set(tenantMembers.map((m) => m.userId));

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["users"] });
    if (tenantId) {
      qc.invalidateQueries({ queryKey: ["tenants", tenantId, "memberships"] });
    }
  };

  const patch = useMutation({
    mutationFn: (v: { id: string; body: Partial<User> }) =>
      apiFetch(`/api/users/${v.id}`, { method: "PATCH", body: JSON.stringify(v.body) }),
    onSuccess: invalidate,
    onError: (e: Error) => toast({ variant: "destructive", title: "Update failed", description: e.message }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/users/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidate();
      toast({ title: "User deleted" });
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Delete failed", description: e.message }),
  });

  return (
    <div className="flex h-full flex-col">
      {/* Page Header */}
      <div className="flex flex-col gap-2 border-b bg-card px-4 py-5 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:px-6 sm:py-5">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Users
          </h1>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {tenantId
              ? "Administra los usuarios y miembros de esta organización."
              : "Administra quién puede acceder a este panel. Los agentes solo ven la bandeja de entrada y los contactos."}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {tenantId && currentRole === "SYSTEM_ADMIN" && (
            <Dialog open={addMemberOpen} onOpenChange={setAddMemberOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" className="h-9 gap-2 rounded-lg px-3 text-sm font-medium shadow-sm">
                  <UserPlus className="h-4 w-4" /> Add member to tenant
                </Button>
              </DialogTrigger>
              <AddTenantMemberDialog
                tenantId={tenantId}
                users={users.filter((u) => u.active && !memberUserIds.has(u.id))}
                onClose={() => setAddMemberOpen(false)}
                onAdded={() => {
                  invalidate();
                  setAddMemberOpen(false);
                }}
              />
            </Dialog>
          )}
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="h-9 gap-2 rounded-lg px-4 text-sm font-medium shadow-sm">
                <Plus className="h-4 w-4" /> New user
              </Button>
            </DialogTrigger>
            <CreateUserDialog
              onClose={() => setOpen(false)}
              onCreated={invalidate}
              canCreateSystemAdmin={canManageSystemAdmins}
            />
          </Dialog>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 sm:p-6">
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Usuario</TableHead>
                {tenantId && <TableHead className="w-36">Acceso al tenant</TableHead>}
                <TableHead className="w-40">Rol</TableHead>
                <TableHead className="w-28">Estado</TableHead>
                <TableHead className="w-40">Creado</TableHead>
                <TableHead className="w-28 pr-4 text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={tenantId ? 6 : 5} className="py-8 text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {users.map((u) => {
                const self = u.id === currentUserId;
                const isMember = memberUserIds.has(u.id);
                const initials = u.name
                  .trim()
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((w) => w[0]?.toUpperCase() ?? "")
                  .join("");
                return (
                  <TableRow key={u.id}>
                    <TableCell data-label="Usuario">
                      <div className="flex min-w-0 items-center gap-3">
                        <Avatar className="h-9 w-9 shrink-0">
                          <AvatarFallback>{initials}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-medium text-foreground" title={u.name}>
                              {u.name}
                            </span>
                            {self && (
                              <Badge
                                variant="outline"
                                className="shrink-0 rounded px-1.5 py-0 text-[10px] font-medium text-muted-foreground"
                              >
                                Tú
                              </Badge>
                            )}
                          </div>
                          <p className="truncate text-xs text-muted-foreground" title={u.email}>
                            {u.email}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    {tenantId && (
                      <TableCell data-label="Acceso al tenant">
                        {isMember ? (
                          <Badge variant="outline" className="bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-300">
                            <Check className="h-3 w-3 mr-1 inline" /> Member
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">Not member</span>
                        )}
                      </TableCell>
                    )}
                    <TableCell data-label="Rol">
                      <Select
                        value={u.role}
                        onValueChange={(role) => patch.mutate({ id: u.id, body: { role: role as User["role"] } })}
                        disabled={self || (!canManageSystemAdmins && u.role === "SYSTEM_ADMIN")}
                      >
                        <SelectTrigger className="h-8 w-36 rounded-md" aria-label={`Rol de ${u.name}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="AGENT">Agent</SelectItem>
                          <SelectItem value="ADMIN">Admin</SelectItem>
                          {canManageSystemAdmins && (
                            <SelectItem value="SYSTEM_ADMIN">System Admin</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell data-label="Estado">
                      <button
                        type="button"
                        disabled={self || (!canManageSystemAdmins && u.role === "SYSTEM_ADMIN")}
                        onClick={() => patch.mutate({ id: u.id, body: { active: !u.active } })}
                        aria-label={u.active ? `Desactivar a ${u.name}` : `Activar a ${u.name}`}
                        title={u.active ? "Desactivar" : "Activar"}
                        className="rounded-md p-0.5 transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <Badge variant={u.active ? "success" : "secondary"}>
                          {u.active ? "Active" : "Disabled"}
                        </Badge>
                      </button>
                    </TableCell>
                    <TableCell data-label="Creado" className="text-xs tabular-nums text-muted-foreground">
                      {formatDateTime(u.createdAt)}
                    </TableCell>
                    <TableCell data-label="Acciones" className="text-right">
                      <div className="flex justify-end gap-1.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Reset password"
                          aria-label={`Reset password for ${u.name}`}
                          className="rounded-md text-muted-foreground hover:text-foreground"
                          disabled={!canManageSystemAdmins && u.role === "SYSTEM_ADMIN"}
                          onClick={() => setResetFor(u)}
                        >
                          <KeyRound className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Delete"
                          aria-label={`Delete ${u.name}`}
                          className="rounded-md hover:bg-destructive/10 hover:text-destructive"
                          disabled={self || (!canManageSystemAdmins && u.role === "SYSTEM_ADMIN")}
                          onClick={() => setDeleteFor(u)}
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

      <Dialog open={!!resetFor} onOpenChange={(o) => !o && setResetFor(null)}>
        {resetFor && (
          <ResetPasswordDialog
            user={resetFor}
            onDone={() => setResetFor(null)}
          />
        )}
      </Dialog>

      <Dialog open={!!deleteFor} onOpenChange={(o) => !o && setDeleteFor(null)}>
        {deleteFor && (
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Delete user</DialogTitle>
              <DialogDescription>
                ¿Eliminar a <span className="font-medium text-foreground">{deleteFor.name}</span> (
                {deleteFor.email})? Esta acción no se puede deshacer.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setDeleteFor(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={remove.isPending}
                onClick={() => {
                  remove.mutate(deleteFor.id, { onSettled: () => setDeleteFor(null) });
                }}
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

function CreateUserDialog({
  onClose,
  onCreated,
  canCreateSystemAdmin,
}: {
  onClose: () => void;
  onCreated: () => void;
  canCreateSystemAdmin: boolean;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "AGENT" as User["role"] });

  const create = useMutation({
    mutationFn: () => apiFetch("/api/users", { method: "POST", body: JSON.stringify(form) }),
    onSuccess: () => {
      toast({ title: "User created" });
      onCreated();
      onClose();
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Create failed", description: e.message }),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>New user</DialogTitle>
        <DialogDescription>They sign in with this email and password.</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1">
          <Label>Name</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label>Email</Label>
          <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label>Password</Label>
          <Input
            type="text"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder="At least 8 characters"
          />
        </div>
        <div className="space-y-1">
          <Label>Role</Label>
          <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v as User["role"] })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="AGENT">Agent — inbox &amp; contacts only</SelectItem>
              <SelectItem value="ADMIN">Admin — full access</SelectItem>
              {canCreateSystemAdmin && (
                <SelectItem value="SYSTEM_ADMIN">System Admin — tenant administration</SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => create.mutate()} disabled={create.isPending}>
          Create
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function ResetPasswordDialog({ user, onDone }: { user: User; onDone: () => void }) {
  const { toast } = useToast();
  const [password, setPassword] = useState("");
  const reset = useMutation({
    mutationFn: () =>
      apiFetch(`/api/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ password }) }),
    onSuccess: () => {
      toast({ title: "Password updated" });
      onDone();
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Failed", description: e.message }),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Reset password</DialogTitle>
        <DialogDescription>Set a new password for {user.name}.</DialogDescription>
      </DialogHeader>
      <div className="space-y-1">
        <Label>New password</Label>
        <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
      </div>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" disabled={password.length < 8 || reset.isPending} onClick={() => reset.mutate()}>
          Update password
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function AddTenantMemberDialog({
  tenantId,
  users,
  onClose,
  onAdded,
}: {
  tenantId: string;
  users: User[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const { toast } = useToast();
  const [selectedUserId, setSelectedUserId] = useState("");

  const add = useMutation({
    mutationFn: () =>
      apiFetch(`/api/tenants/${tenantId}/memberships`, {
        method: "POST",
        body: JSON.stringify({ userId: selectedUserId }),
      }),
    onSuccess: () => {
      toast({ title: "User assigned as tenant member" });
      onAdded();
    },
    onError: (e: Error) => {
      toast({ variant: "destructive", title: "Assignment failed", description: e.message });
    },
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Add member to tenant</DialogTitle>
        <DialogDescription>
          Assign an existing user to this tenant so they can access its inbox, contacts, and resources.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        {users.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            All active users are already assigned to this tenant.
          </p>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="member-user-select">Select user</Label>
            <Select value={selectedUserId} onValueChange={setSelectedUserId}>
              <SelectTrigger id="member-user-select">
                <SelectValue placeholder="Choose an active user..." />
              </SelectTrigger>
              <SelectContent>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name} ({u.email}) — {u.role}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!selectedUserId || add.isPending || users.length === 0}
          onClick={() => add.mutate()}
        >
          {add.isPending ? "Adding..." : "Add member"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
