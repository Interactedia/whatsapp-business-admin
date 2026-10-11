import { TenantSelector } from "@/components/tenant/tenant-selector";
import { SettingsClient } from "@/app/(app)/settings/settings-client";
import { requireTenantAdmin } from "@/lib/tenant/page-guards";

export default async function TenantSettingsPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  const { membership, memberships } = await requireTenantAdmin(tenantId);
  if (!membership) {
    return <TenantSelector memberships={memberships} />;
  }

  return <SettingsClient tenantId={tenantId} />;
}
