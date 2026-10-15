"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Building2, UserPlus, UserMinus } from "lucide-react";
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

type Tenant = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  _count?: {
    tenantMemberships: number;
    contacts: number;
    conversations: number;
  };
};

type Membership = {
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

type User = {
  id: string;
  name: string;
  email: string;
  role: "SYSTEM_ADMIN" | "ADMIN" | "AGENT";
  active: boolean;
};

export function AdminTenantsClient() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTenant, setSelectedTenant] = useState<Tenant | null>(null);

  const { data: tenants = [], isLoading } = useQuery({
    queryKey: ["admin", "tenants"],
    queryFn: () => apiFetch<Tenant[]>("/api/tenants"),
  });

  const invalidateTenants = () => qc.invalidateQueries({ queryKey: ["admin", "tenants"] });

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Tenant Administration"
        description="Centralized organization and tenant management for system administrators."
        actions={
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4 mr-1" /> New tenant
              </Button>
            </DialogTrigger>
            <CreateTenantDialog
              onClose={() => setCreateOpen(false)}
              onCreated={() => {
                invalidateTenants();
                setCreateOpen(false);
              }}
            />
          </Dialog>
        }
      />

      <div className="flex-1 overflow-auto p-6">
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Organization</TableHead>
                <TableHead>Members</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right pr-4">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                    Loading tenants...
                  </TableCell>
                </TableRow>
              ) : tenants.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                    No tenants found. Click &quot;New tenant&quot; to create one.
                  </TableCell>
                </TableRow>
              ) : (
                tenants.map((t) => (
                  <TableRow
                    key={t.id}
                    className="group hover:bg-accent/50"
                  >
                    <TableCell className="pl-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                          <Building2 className="h-4 w-4 text-primary" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{t.name}</p>
                          <p className="text-xs font-mono text-muted-foreground truncate">{t.id}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="py-3">
                      <Badge variant="secondary" className="font-normal">
                        {t._count?.tenantMemberships ?? 0} member{t._count?.tenantMemberships !== 1 ? "s" : ""}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-3 text-sm text-muted-foreground">{formatDateTime(t.createdAt)}</TableCell>
                    <TableCell className="py-3 pr-4 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setSelectedTenant(t)}
                        className="hover:bg-accent"
                      >
                        Member detail
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {selectedTenant && (
        <TenantMembersDialog
          tenant={selectedTenant}
          onClose={() => {
            setSelectedTenant(null);
            invalidateTenants();
          }}
        />
      )}
    </div>
  );
}

function CreateTenantDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const { toast } = useToast();

  const create = useMutation({
    mutationFn: (body: { name: string }) =>
      apiFetch<Tenant>("/api/tenants", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      toast({ title: "Tenant created successfully" });
      onCreated();
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Failed to create tenant", description: err.message });
    },
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Create new tenant</DialogTitle>
        <DialogDescription>
          Organizations provide strict tenant isolation for WhatsApp assets, contacts, and conversations.
        </DialogDescription>
      </DialogHeader>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          create.mutate({ name: name.trim() });
        }}
        className="space-y-4"
      >
        <div className="space-y-2">
          <Label htmlFor="tenant-name">Tenant name</Label>
          <Input
            id="tenant-name"
            placeholder="e.g. Acme Corporation"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending || !name.trim()}>
            {create.isPending ? "Creating..." : "Create tenant"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function TenantMembersDialog({ tenant, onClose }: { tenant: Tenant; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [removeFor, setRemoveFor] = useState<Membership | null>(null);

  const { data: members = [], isLoading: loadingMembers } = useQuery({
    queryKey: ["admin", "tenants", tenant.id, "memberships"],
    queryFn: () => apiFetch<Membership[]>(`/api/tenants/${tenant.id}/memberships`),
  });

  const { data: allUsers = [] } = useQuery({
    queryKey: ["users"],
    queryFn: () => apiFetch<User[]>("/api/users"),
  });

  const invalidateMembers = () => {
    qc.invalidateQueries({ queryKey: ["admin", "tenants", tenant.id, "memberships"] });
    qc.invalidateQueries({ queryKey: ["admin", "tenants"] });
  };

  const addMember = useMutation({
    mutationFn: (userId: string) =>
      apiFetch<Membership>(`/api/tenants/${tenant.id}/memberships`, {
        method: "POST",
        body: JSON.stringify({ userId }),
      }),
    onSuccess: () => {
      toast({ title: "User added to tenant" });
      setSelectedUserId("");
      setAddOpen(false);
      invalidateMembers();
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Failed to add member", description: err.message });
    },
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) =>
      apiFetch<{ deleted: boolean }>(
        `/api/tenants/${tenant.id}/memberships?userId=${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      toast({ title: "Member removed from organization" });
      setRemoveFor(null);
      invalidateMembers();
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Failed to remove member", description: err.message });
      setRemoveFor(null);
    },
  });

  // Filter users who are not already members
  const memberUserIds = new Set(members.map((m) => m.userId));
  const availableUsers = allUsers.filter((u) => u.active && !memberUserIds.has(u.id));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Member detail — {tenant.name}</DialogTitle>
          <DialogDescription>
            Tenant ID: <span className="font-mono text-xs">{tenant.id}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">Active Members ({members.length})</h4>
            <Button size="sm" onClick={() => setAddOpen(true)} disabled={availableUsers.length === 0}>
              <UserPlus className="h-4 w-4 mr-1" /> Add member
            </Button>
          </div>

          {addOpen && (
            <div className="rounded-md border p-3 bg-muted/30 space-y-3">
              <Label htmlFor="select-user">Select existing user to assign as tenant member</Label>
              <div className="flex items-center gap-2">
                <Select value={selectedUserId} onValueChange={setSelectedUserId}>
                  <SelectTrigger id="select-user" className="flex-1">
                    <SelectValue placeholder="Choose a user..." />
                  </SelectTrigger>
                  <SelectContent>
                    {availableUsers.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.name} ({u.email}) — {u.role}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  disabled={!selectedUserId || addMember.isPending}
                  onClick={() => addMember.mutate(selectedUserId)}
                >
                  {addMember.isPending ? "Adding..." : "Confirm"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAddOpen(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          <div className="rounded-md border max-h-72 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingMembers ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-4">
                      Loading members...
                    </TableCell>
                  </TableRow>
                ) : members.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-4">
                      No members assigned to this tenant yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  members.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell className="font-medium">{m.user.name}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{m.user.email}</TableCell>
                      <TableCell>
                        <Badge variant={m.user.role === "ADMIN" || m.user.role === "SYSTEM_ADMIN" ? "default" : "secondary"}>
                          {m.user.role}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatDateTime(m.createdAt)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-muted-foreground hover:text-destructive"
                          disabled={removeMember.isPending}
                          onClick={() => setRemoveFor(m)}
                        >
                          <UserMinus className="h-3.5 w-3.5 mr-1" /> Quitar
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>

      <Dialog open={!!removeFor} onOpenChange={(o) => !o && !removeMember.isPending && setRemoveFor(null)}>
        {removeFor && (
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>¿Quitar miembro de la organización?</DialogTitle>
              <DialogDescription>
                Este usuario perderá acceso a esta organización. Su cuenta y sus accesos a otras
                organizaciones no serán eliminados.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                disabled={removeMember.isPending}
                onClick={() => setRemoveFor(null)}
              >
                Cancelar
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={removeMember.isPending}
                onClick={() => removeMember.mutate(removeFor.userId)}
              >
                {removeMember.isPending ? "Quitando..." : "Quitar acceso"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </Dialog>
  );
}
