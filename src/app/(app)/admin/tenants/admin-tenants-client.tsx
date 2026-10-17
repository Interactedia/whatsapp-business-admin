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
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTenant, setSelectedTenant] = useState<Tenant | null>(null);
  const { t } = useI18n();

  const { data: tenants = [], isLoading } = useQuery({
    queryKey: ["admin", "tenants"],
    queryFn: () => apiFetch<Tenant[]>("/api/tenants"),
  });

  const invalidateTenants = () => qc.invalidateQueries({ queryKey: ["admin", "tenants"] });

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t("tenants.admin.title")}
        description={t("tenants.admin.description")}
        actions={
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4 mr-1" /> {t("tenants.admin.newTenant")}
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
                <TableHead className="pl-4">{t("tenants.admin.table.organization")}</TableHead>
                <TableHead>{t("tenants.admin.table.members")}</TableHead>
                <TableHead>{t("tenants.admin.table.created")}</TableHead>
                <TableHead className="text-right pr-4">{t("tenants.admin.table.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                    {t("tenants.admin.loading")}
                  </TableCell>
                </TableRow>
              ) : tenants.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                    {t("tenants.admin.empty")}
                  </TableCell>
                </TableRow>
              ) : (
                tenants.map((tenant) => (
                  <TableRow
                    key={tenant.id}
                    className="group hover:bg-accent/50"
                  >
                    <TableCell className="pl-4 py-3" data-label={t("tenants.admin.table.organization")}>
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
                    <TableCell className="py-3" data-label={t("tenants.admin.table.members")}>
                      <Badge variant="secondary" className="font-normal">
                        {tenant._count?.tenantMemberships ?? 0}{" "}
                        {(tenant._count?.tenantMemberships ?? 0) === 1
                          ? t("tenants.admin.badge.member_one")
                          : t("tenants.admin.badge.member_other")}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-3 text-sm text-muted-foreground" data-label={t("tenants.admin.table.created")}>{formatDateTime(tenant.createdAt)}</TableCell>
                    <TableCell className="py-3 pr-4 text-right" data-label={t("tenants.admin.table.actions")}>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setSelectedTenant(tenant)}
                        className="hover:bg-accent"
                      >
                        {t("tenants.admin.memberDetail")}
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
  const { t } = useI18n();

  const create = useMutation({
    mutationFn: (body: { name: string }) =>
      apiFetch<Tenant>("/api/tenants", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      toast({ title: t("tenants.create.success") });
      onCreated();
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: t("tenants.create.error"), description: err.message });
    },
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t("tenants.create.title")}</DialogTitle>
        <DialogDescription>
          {t("tenants.create.description")}
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
          <Label htmlFor="tenant-name">{t("tenants.create.label")}</Label>
          <Input
            id="tenant-name"
            placeholder={t("tenants.create.placeholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("tenants.create.cancel")}
          </Button>
          <Button type="submit" disabled={create.isPending || !name.trim()}>
            {create.isPending ? t("tenants.create.submitting") : t("tenants.create.submit")}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function TenantMembersDialog({ tenant, onClose }: { tenant: Tenant; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = useI18n();
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
      toast({ title: t("tenants.members.addSuccess") });
      setSelectedUserId("");
      setAddOpen(false);
      invalidateMembers();
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: t("tenants.members.addError"), description: err.message });
    },
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) =>
      apiFetch<{ deleted: boolean }>(
        `/api/tenants/${tenant.id}/memberships?userId=${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      toast({ title: t("tenants.members.removeSuccess") });
      setRemoveFor(null);
      invalidateMembers();
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: t("tenants.members.removeError"), description: err.message });
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
          <DialogTitle>{t("tenants.members.title")} — {tenant.name}</DialogTitle>
          <DialogDescription>
            {t("tenants.members.tenantId")} <span className="font-mono text-xs">{tenant.id}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">
              {members.length === 1
                ? t("tenants.members.activeCount_one")
                : t("tenants.members.activeCount")} ({members.length})
            </h4>
            <Button size="sm" onClick={() => setAddOpen(true)} disabled={availableUsers.length === 0}>
              <UserPlus className="h-4 w-4 mr-1" /> {t("tenants.members.addMember")}
            </Button>
          </div>

          {addOpen && (
            <div className="rounded-md border p-3 bg-muted/30 space-y-3">
              <Label htmlFor="select-user">{t("tenants.members.selectLabel")}</Label>
              <div className="flex items-center gap-2">
                <Select value={selectedUserId} onValueChange={setSelectedUserId}>
                  <SelectTrigger id="select-user" className="flex-1">
                    <SelectValue placeholder={t("tenants.members.selectPlaceholder")} />
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
                  {addMember.isPending ? t("tenants.members.confirming") : t("tenants.members.confirm")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAddOpen(false)}>
                  {t("tenants.members.cancel")}
                </Button>
              </div>
            </div>
          )}

          <div className="rounded-md border max-h-72 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("tenants.members.table.user")}</TableHead>
                  <TableHead>{t("tenants.members.table.email")}</TableHead>
                  <TableHead>{t("tenants.members.table.role")}</TableHead>
                  <TableHead>{t("tenants.members.table.added")}</TableHead>
                  <TableHead className="text-right">{t("tenants.members.table.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingMembers ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-4">
                      {t("tenants.members.loading")}
                    </TableCell>
                  </TableRow>
                ) : members.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-4">
                      {t("tenants.members.empty")}
                    </TableCell>
                  </TableRow>
                ) : (
                  members.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell className="font-medium" data-label={t("tenants.members.table.user")}>{m.user.name}</TableCell>
                      <TableCell className="text-xs text-muted-foreground" data-label={t("tenants.members.table.email")}>{m.user.email}</TableCell>
                      <TableCell data-label={t("tenants.members.table.role")}>
                        <Badge variant={m.user.role === "ADMIN" || m.user.role === "SYSTEM_ADMIN" ? "default" : "secondary"}>
                          {m.user.role}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground" data-label={t("tenants.members.table.added")}>{formatDateTime(m.createdAt)}</TableCell>
                      <TableCell className="text-right" data-label={t("tenants.members.table.actions")}>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-muted-foreground hover:text-destructive"
                          disabled={removeMember.isPending}
                          onClick={() => setRemoveFor(m)}
                        >
                          <UserMinus className="h-3.5 w-3.5 mr-1" /> {t("tenants.members.remove")}
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
            {t("tenants.members.close")}
          </Button>
        </DialogFooter>
      </DialogContent>

      <Dialog open={!!removeFor} onOpenChange={(o) => !o && !removeMember.isPending && setRemoveFor(null)}>
        {removeFor && (
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t("tenants.remove.title")}</DialogTitle>
              <DialogDescription>
                {t("tenants.remove.description")}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                disabled={removeMember.isPending}
                onClick={() => setRemoveFor(null)}
              >
                {t("tenants.remove.cancel")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={removeMember.isPending}
                onClick={() => removeMember.mutate(removeFor.userId)}
              >
                {removeMember.isPending ? t("tenants.remove.confirming") : t("tenants.remove.confirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </Dialog>
  );
}
