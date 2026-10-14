"use client";

import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/shell/app-shell";
import { apiFetch } from "@/lib/fetcher";
import type { TenantMembershipSummary } from "@/components/tenant/organization-selector";

type Props = {
  user: { name: string; email: string; role: "SYSTEM_ADMIN" | "ADMIN" | "AGENT" };
  memberships: TenantMembershipSummary[];
  wabaConnected: boolean;
  phoneNumber: string | null;
  children: React.ReactNode;
};

type TenantSettings = {
  connected: boolean;
  phoneNumberDisplay: string;
  phoneNumberId: string;
};

/**
 * Client wrapper for AppShell with tenant context.
 * Extracts activeTenantId from the current URL path.
 *
 * The server layout intentionally does not choose a tenant WABA. Refetch the
 * active tenant settings on the client so the sidebar footer follows tenant
 * switches without falling back to another tenant or the legacy singleton.
 */
export function AppShellClient({ user, memberships, wabaConnected, phoneNumber, children }: Props) {
  const pathname = usePathname();

  // Extract tenantId from /t/:tenantId/... path
  const activeTenantId = (() => {
    const match = pathname.match(/^\/t\/([^/]+)/);
    return match ? match[1] : null;
  })();

  const { data: tenantSettings } = useQuery<TenantSettings>({
    queryKey: ["shell", "tenant-settings", activeTenantId],
    queryFn: () => apiFetch<TenantSettings>(`/api/tenants/${activeTenantId}/settings`),
    enabled: Boolean(activeTenantId),
    staleTime: 30_000,
  });

  // Prefer the active tenant's connection state. Without an active tenant,
  // show the neutral server value instead of guessing a WABA.
  const resolvedConnected = tenantSettings
    ? Boolean(tenantSettings.connected)
    : wabaConnected;
  const resolvedPhone =
    tenantSettings?.phoneNumberDisplay ||
    tenantSettings?.phoneNumberId ||
    phoneNumber;

  return (
    <AppShell
      user={user}
      memberships={memberships}
      activeTenantId={activeTenantId}
      wabaConnected={resolvedConnected}
      phoneNumber={resolvedPhone}
    >
      {children}
    </AppShell>
  );
}
