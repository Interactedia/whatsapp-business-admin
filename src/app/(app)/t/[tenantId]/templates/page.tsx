import { TenantSelector } from "@/components/tenant/tenant-selector";
import { TemplatesClient } from "@/app/(app)/templates/templates-client";
import { requireTenantAdmin } from "@/lib/tenant/page-guards";

export default async function TenantTemplatesPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  const { membership, memberships } = await requireTenantAdmin(tenantId);
  if (!membership) {
    return <TenantSelector memberships={memberships} />;
  }

  return <TemplatesClient />;
}
