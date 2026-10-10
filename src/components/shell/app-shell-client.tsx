"use client";

import { usePathname } from "next/navigation";
import { AppShell } from "@/components/shell/app-shell";
import type { TenantMembershipSummary } from "@/components/tenant/organization-selector";

type Props = {
  user: { name: string; email: string; role: "ADMIN" | "AGENT" };
  memberships: TenantMembershipSummary[];
  wabaConnected: boolean;
  phoneNumber: string | null;
  children: React.ReactNode;
};

/**
 * Client wrapper for AppShell with tenant context.
 * Extracts activeTenantId from the current URL path.
 */
export function AppShellClient({ user, memberships, wabaConnected, phoneNumber, children }: Props) {
  const pathname = usePathname();

  // Extract tenantId from /t/:tenantId/... path
  const activeTenantId = (() => {
    const match = pathname.match(/^\/t\/([^/]+)/);
    return match ? match[1] : null;
  })();

  return (
    <AppShell
      user={user}
      memberships={memberships}
      activeTenantId={activeTenantId}
      wabaConnected={wabaConnected}
      phoneNumber={phoneNumber}
    >
      {children}
    </AppShell>
  );
}
