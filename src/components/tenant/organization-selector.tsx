"use client";

import { useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type TenantMembershipSummary = {
  id: string;
  tenantId: string;
  tenant: { id: string; name: string };
};

/**
 * OrganizationSelector - compact dropdown in the app header.
 * Shows the active organization and allows switching between authorized memberships.
 * Zero memberships: shows empty state guidance.
 * One membership: shows single tenant with dropdown.
 * Multiple memberships: shows current + dropdown list.
 */
export function OrganizationSelector({
  memberships,
  activeTenantId,
}: {
  memberships: TenantMembershipSummary[];
  activeTenantId: string | null;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const qc = useQueryClient();

  const activeMembership = memberships.find((m) => m.tenantId === activeTenantId);
  const isTenantScoped = pathname.startsWith("/t/");

  // Determine which resource to navigate to based on current path
  const getDefaultResource = useCallback((): string => {
    if (pathname.includes("/conversations") || pathname.includes("/inbox")) return "conversations";
    if (pathname.includes("/contacts")) return "contacts";
    if (pathname.includes("/templates")) return "templates";
    if (pathname.includes("/flows")) return "flows";
    if (pathname.includes("/broadcasts")) return "broadcasts";
    if (pathname.includes("/settings")) return "settings";
    if (pathname.includes("/developer")) return "developer";
    if (pathname.includes("/submissions")) return "submissions";
    if (pathname.includes("/logs")) return "logs";
    if (pathname.includes("/users")) return "users";
    return "conversations"; // default to inbox/conversations
  }, [pathname]);

  const handleSwitchTenant = (tenantId: string) => {
    // Drop ALL cached queries (not just invalidate) so no data from the
    // previous tenant is briefly shown while the new tenant's data loads.
    qc.cancelQueries();
    qc.removeQueries();
    qc.invalidateQueries();

    // Navigate to the new tenant workspace
    router.push(`/t/${tenantId}/${getDefaultResource()}`);
  };

  // Zero memberships: show guidance
  if (memberships.length === 0) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-1.5 text-muted-foreground"
        disabled
      >
        <Building2 className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">No organization</span>
      </Button>
    );
  }

  // One membership: show compact indicator (no dropdown needed)
  if (memberships.length === 1) {
    const m = memberships[0];
    return (
      <Button
        variant="outline"
        size="sm"
        className={cn(
          "h-8 gap-1.5",
          !isTenantScoped && "border-dashed"
        )}
        onClick={() => !isTenantScoped && handleSwitchTenant(m.tenantId)}
        title={m.tenant.name}
      >
        <Building2 className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="max-w-[120px] truncate text-xs font-medium sm:max-w-[160px] sm:text-sm">
          {m.tenant.name}
        </span>
      </Button>
    );
  }

  // Multiple memberships: full dropdown selector
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
        >
          <Building2 className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="max-w-[120px] truncate text-xs font-medium sm:max-w-[160px] sm:text-sm">
            {activeMembership?.tenant.name || "Select organization"}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Organizations
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {memberships.map((m) => {
          const isActive = m.tenantId === activeTenantId;
          return (
            <DropdownMenuItem
              key={m.id}
              onClick={() => !isActive && handleSwitchTenant(m.tenantId)}
              className={cn(
                "flex items-center gap-2",
                isActive && "bg-accent/50"
              )}
              disabled={isActive}
            >
              <div className="flex flex-1 items-center gap-2 min-w-0">
                <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm">{m.tenant.name}</span>
              </div>
              {isActive && (
                <Check className="h-4 w-4 shrink-0 text-primary" />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
