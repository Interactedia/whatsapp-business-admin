"use client";

import { useRouter } from "next/navigation";
import { Building2, ChevronDown } from "lucide-react";
import { InboxClient } from "@/app/(app)/inbox/inbox-client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { TenantMembership } from "@/components/tenant/tenant-selector";

export function TenantConversationsClient({
  tenant,
  memberships,
}: {
  tenant: { id: string; name: string };
  memberships: TenantMembership[];
}) {
  const router = useRouter();

  return (
    <div className="flex h-full flex-col">
      {/* Tenant-aware header */}
      <div className="flex min-h-11 items-center justify-between border-b bg-card px-3 py-2">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{tenant.name}</span>
        </div>
        {memberships.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
                <span className="max-w-24 truncate">{tenant.name}</span>
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem className="text-xs font-medium" disabled>
                Switch tenant
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {memberships.map((m) =>
                m.tenantId === tenant.id ? (
                  <DropdownMenuItem key={m.id} className="text-xs" disabled>
                    {m.tenant.name}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    key={m.id}
                    className="text-xs cursor-pointer"
                    onClick={() => router.push(`/t/${m.tenantId}/conversations`)}
                  >
                    {m.tenant.name}
                  </DropdownMenuItem>
                ),
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Conversation list — reads from tenant-scoped API */}
      <div className="flex-1 overflow-hidden">
        <InboxClient
          conversationsUrl={`/api/tenants/${tenant.id}/conversations`}
          basePath={`/t/${tenant.id}/conversations`}
        />
      </div>
    </div>
  );
}
