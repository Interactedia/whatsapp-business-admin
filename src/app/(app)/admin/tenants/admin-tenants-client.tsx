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
import { useI18n } from "@/components/i18n/language-provider";

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
  const { t } = useI18n();
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
        title={t("admin.tenants.title", "Tenant Administration")}
        description={t(
          "admin.tenants.description",
          "Centralized organization and tenant management for system administrators.",
        )}
        actions={
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4 mr-1" /> {t("admin.tenants.newTenant", "New tenant")}
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
                <TableHead className="pl-4">{t("admin.tenants.table.organization", "Organization")}</TableHead>
                <TableHead>{t("admin.tenants.table.members", "Members")}</TableHead>
                <TableHead>{t("admin.tenants.table.created", "Created")}</TableHead>
                <TableHead className="text-right pr-4">{t("admin.tenants.table.actions", "Actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                    {t("admin.tenants.loading", "Loading tenants...")}
                  </TableCell>
                </TableRow>
              ) : tenants.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                    {t("admin.tenants.empty", 'No tenants found. Click "New tenant" to create one.')}
                  </TableCell>
                </TableRow>
              ) : (
                tenants.map((tenant) => (
                  <TableRow
                    key={tenant.id}
                    className="group hover:bg-accent/50"
                  >
                    <TableCell className="pl-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                          <Building2 className="h-4 w-4 text-primary" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{tenant.name}</p>
                          <p className="text-xs font-mono text-muted-foreground truncate">{tenant.id}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="py-3">
                      <Badge variant="secondary" className="font-normal">
                        {tenant._count?.tenantMemberships ?? 0}{" "}
                        {(tenant._count?.tenantMemberships ?? 0) === 1
                          ? t("admin.tenants.member_one", "member")
                          : t("admin.tenants.member_other", "members")}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-3 text-sm text-muted-foreground">{formatDateTime(tenant.createdAt)}</TableCell>
                    <TableCell className="py-3 pr-4 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setSelectedTenant(tenant)}
                        className="hover:bg-accent"
                      >
                        {t("admin.tenants.memberDetail", "Member detail")}
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
  const { t } = useI18n();
  const [name, setName] = useState("");
  const { toast } = useToast();

  const create = useMutation({
    mutationFn: (body: { name: string }) =>
      apiFetch<Tenant>("/api/tenants", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      toast({ title: t("admin.tenants.create.success", "Tenant created successfully") });
      onCreated();
    },
    onError: (err: Error) => {
      toast({
        variant: "destructive",
        title: t("admin.tenants.create.error", "Failed to create tenant"),
        description: err.message,
      });
    },
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t("admin.tenants.createTitle", "Create new tenant")}</DialogTitle>
        <DialogDescription>
          {t(
            "admin.tenants.createDescription",
            "Organizations provide strict tenant isolation for WhatsApp assets, contacts, and conversations.",
          )}
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
          <Label htmlFor="tenant-name">{t("admin.tenants.create.nameLabel", "Tenant name")}</Label>
          <Input
            id="tenant-name"
            placeholder={t("admin.tenants.create.namePlaceholder", "e.g. Acme Corporation")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("admin.tenants.create.cancel", "Cancel")}
          </Button>
          <Button type="submit" disabled={create.isPending || !name.trim()}>
            {create.isPending
              ? t("admin.tenants.create.creating", "Creating...")
              : t("admin.tenants.create.submit", "Create tenant")}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function TenantMembersDialog({ tenant, onClose }: { tenant: Tenant; onClose: () => void }) {
  const { t } = useI18n();
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
      toast({ title: t("admin.tenants.addMember.success", "User added to tenant") });
      setSelectedUserId("");
      setAddOpen(false);
      invalidateMembers();
    },
    onError: (err: Error) => {
      toast({
        variant: "destructive",
        title: t("admin.tenants.addMember.error", "Failed to add member"),
        description: err.message,
      });
    },
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) =>
      apiFetch<{ deleted: boolean }>(
        `/api/tenants/${tenant.id}/memberships?userId=${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      toast({ title: t("admin.tenants.members.removeSuccess", "Member removed from organization") });
      setRemoveFor(null);
      invalidateMembers();
    },
    onError: (err: Error) => {
      toast({
        variant: "destructive",
        title: t("admin.tenants.members.removeError", "Failed to remove member"),
        description: err.message,
      });
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
          <DialogTitle>
            {t("admin.tenants.members.title", "Member detail — {tenant}").replace("{tenant}", tenant.name)}
          </DialogTitle>
          <DialogDescription>
            {t("admin.tenants.members.tenantId", "Tenant ID:")}{" "}
            <span className="font-mono text-xs">{tenant.id}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">
              {t("admin.tenants.members.active", "Active Members ({count})").replace(
                "{count}",
                String(members.length),
              )}
            </h4>
            <Button size="sm" onClick={() => setAddOpen(true)} disabled={availableUsers.length === 0}>
              <UserPlus className="h-4 w-4 mr-1" /> {t("admin.tenants.addMemberTitle", "Add member")}
            </Button>
          </div>

          {addOpen && (
            <div className="rounded-md border p-3 bg-muted/30 space-y-3">
              <Label htmlFor="select-user">
                {t(
                  "admin.tenants.members.selectLabel",
                  "Select existing user to assign as tenant member",
                )}
              </Label>
              <div className="flex items-center gap-2">
                <Select value={selectedUserId} onValueChange={setSelectedUserId}>
                  <SelectTrigger id="select-user" className="flex-1">
                    <SelectValue placeholder={t("admin.tenants.members.selectPlaceholder", "Choose a user...")} />
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
                  {addMember.isPending
                    ? t("admin.tenants.addMember.adding", "Adding...")
                    : t("admin.tenants.members.confirm", "Confirm")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAddOpen(false)}>
                  {t("admin.tenants.addMember.cancel", "Cancel")}
                </Button>
              </div>
            </div>
          )}

          <div className="rounded-md border max-h-72 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("admin.tenants.members.table.user", "User")}</TableHead>
                  <TableHead>{t("admin.tenants.members.table.email", "Email")}</TableHead>
                  <TableHead>{t("admin.tenants.members.table.role", "Role")}</TableHead>
                  <TableHead>{t("admin.tenants.members.table.added", "Added")}</TableHead>
                  <TableHead className="text-right">
                    {t("admin.tenants.members.table.actions", "Actions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingMembers ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-4">
                      {t("admin.tenants.members.loading", "Loading members...")}
                    </TableCell>
                  </TableRow>
                ) : members.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-4">
                      {t("admin.tenants.members.empty", "No members assigned to this tenant yet.")}
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
                          <UserMinus className="h-3.5 w-3.5 mr-1" />{" "}
                          {t("admin.tenants.members.remove", "Quitar")}
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
            {t("admin.tenants.members.close", "Close")}
          </Button>
        </DialogFooter>
      </DialogContent>

      <Dialog open={!!removeFor} onOpenChange={(o) => !o && !removeMember.isPending && setRemoveFor(null)}>
        {removeFor && (
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t("admin.tenants.members.removeTitle", "¿Quitar miembro de la organización?")}</DialogTitle>
              <DialogDescription>
                {t(
                  "admin.tenants.members.removeDesc",
                  "Este usuario perderá acceso a esta organización. Su cuenta y sus accesos a otras organizaciones no serán eliminados.",
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                disabled={removeMember.isPending}
                onClick={() => setRemoveFor(null)}
              >
                {t("admin.tenants.create.cancel", "Cancelar")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={removeMember.isPending}
                onClick={() => removeMember.mutate(removeFor.userId)}
              >
                {removeMember.isPending
                  ? t("admin.tenants.removePending", "Quitando...")
                  : t("admin.tenants.removeAccess", "Quitar acceso")}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </Dialog>
  );
}
