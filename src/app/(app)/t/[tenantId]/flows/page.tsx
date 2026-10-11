import { TenantSelector } from "@/components/tenant/tenant-selector";
import { FlowsClient } from "@/app/(app)/flows/flows-client";
import { requireTenantAdmin } from "@/lib/tenant/page-guards";

export default async function TenantFlowsPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  const { membership, memberships } = await requireTenantAdmin(tenantId);
  if (!membership) {
    return <TenantSelector memberships={memberships} />;
  }

  return <FlowsClient />;
}
