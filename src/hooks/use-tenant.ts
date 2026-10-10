"use client";

import { useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";

export type TenantMembership = {
  id: string;
  tenantId: string;
  tenant: { id: string; name: string };
};

/**
 * Client-side tenant state manager.
 * Manages active tenant selection and provides navigation helpers.
 * Does NOT grant authorization — server-side membership verification is always required.
 */
export function useTenant() {
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();

  /**
   * Extract tenantId from the current URL path (/t/:tenantId/...)
   */
  const getActiveTenantId = useCallback((): string | null => {
    const match = pathname.match(/^\/t\/([^/]+)/);
    return match ? match[1] : null;
  }, [pathname]);

  /**
   * Navigate to a tenant-scoped path, clearing stale tenant data.
   * Always navigates through /t/:tenantId/... routes.
   */
  const switchTenant = useCallback((tenantId: string, resource: string = "conversations") => {
    // Clear all tenant-owned queries to prevent stale data cross-contamination
    qc.cancelQueries();
    qc.invalidateQueries();

    // Navigate to the new tenant workspace
    router.push(`/t/${tenantId}/${resource}`);
  }, [router, qc]);

  /**
   * Navigate within the current tenant to a different resource.
   * Preserves the active tenant context.
   */
  const navigateTo = useCallback((resource: string) => {
    const currentTenant = getActiveTenantId();
    if (currentTenant) {
      router.push(`/t/${currentTenant}/${resource}`);
    }
  }, [router, getActiveTenantId]);

  return {
    getActiveTenantId,
    switchTenant,
    navigateTo,
  };
}
