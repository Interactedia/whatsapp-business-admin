import { TenantSelector } from "@/components/tenant/tenant-selector";
import { BroadcastsClient } from "@/app/(app)/broadcasts/broadcasts-client";
import { requireTenantAdmin } from "@/lib/tenant/page-guards";

export default async function TenantBroadcastsPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  const { membership, memberships } = await requireTenantAdmin(tenantId);
  if (!membership) {
    return <TenantSelector memberships={memberships} />;
  }

  return <BroadcastsClient />;
}
