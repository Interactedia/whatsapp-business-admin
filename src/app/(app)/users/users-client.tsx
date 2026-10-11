"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, KeyRound, UserPlus, Check } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
      <PageHeader
        title={tenantName ? `Users & Members — ${tenantName}` : "Users"}
        description={
          tenantId
            ? "Manage users and assign existing users as members of this tenant."
            : "Manage who can access this admin. Agents see only the inbox and contacts."
        }
        actions={
          <div className="flex items-center gap-2">
            {tenantId && (
              <Dialog open={addMemberOpen} onOpenChange={setAddMemberOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" variant="outline">
                    <UserPlus className="h-4 w-4 mr-1" /> Add member to tenant
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
                <Button size="sm">
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
        }
      />

      <div className="p-3 sm:p-4">
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                {tenantId && <TableHead className="w-32">Tenant Access</TableHead>}
                <TableHead className="w-32">Role</TableHead>
                <TableHead className="w-24">Status</TableHead>
                <TableHead className="w-40">Created</TableHead>
                <TableHead className="w-24 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={tenantId ? 7 : 6} className="text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {users.map((u) => {
                const self = u.id === currentUserId;
                const isMember = memberUserIds.has(u.id);
                return (
                  <TableRow key={u.id}>
                    <TableCell data-label="Name" className="font-medium">
                      {u.name} {self && <span className="text-xs text-muted-foreground">(you)</span>}
                    </TableCell>
                    <TableCell data-label="Email" className="break-all text-muted-foreground">{u.email}</TableCell>
                    {tenantId && (
                      <TableCell data-label="Tenant Access">
                        {isMember ? (
                          <Badge variant="outline" className="bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-300">
                            <Check className="h-3 w-3 mr-1 inline" /> Member
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">Not member</span>
                        )}
                      </TableCell>
                    )}
                    <TableCell data-label="Role">
                      <Select
                        value={u.role}
                        onValueChange={(role) => patch.mutate({ id: u.id, body: { role: role as User["role"] } })}
                        disabled={self || (!canManageSystemAdmins && u.role === "SYSTEM_ADMIN")}
                      >
                        <SelectTrigger className="h-7 w-36">
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
                    <TableCell data-label="Status">
                      <button
                        type="button"
                        disabled={self || (!canManageSystemAdmins && u.role === "SYSTEM_ADMIN")}
                        onClick={() => patch.mutate({ id: u.id, body: { active: !u.active } })}
                        className="disabled:opacity-60"
                      >
                        <Badge variant={u.active ? "success" : "secondary"}>
                          {u.active ? "Active" : "Disabled"}
                        </Badge>
                      </button>
                    </TableCell>
                    <TableCell data-label="Created" className="text-xs text-muted-foreground">
                      {formatDateTime(u.createdAt)}
                    </TableCell>
                    <TableCell data-label="Actions" className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Reset password"
                          disabled={!canManageSystemAdmins && u.role === "SYSTEM_ADMIN"}
                          onClick={() => setResetFor(u)}
                        >
                          <KeyRound className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Delete"
                          disabled={self || (!canManageSystemAdmins && u.role === "SYSTEM_ADMIN")}
                          onClick={() => {
                            if (confirm(`Delete ${u.name}?`)) remove.mutate(u.id);
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

      <Dialog open={!!resetFor} onOpenChange={(o) => !o && setResetFor(null)}>
        {resetFor && (
          <ResetPasswordDialog
            user={resetFor}
            onDone={() => setResetFor(null)}
          />
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
