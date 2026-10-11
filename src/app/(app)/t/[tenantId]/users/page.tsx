import { TenantSelector } from "@/components/tenant/tenant-selector";
import { UsersClient } from "@/app/(app)/users/users-client";
import { requireTenantAdmin } from "@/lib/tenant/page-guards";

export default async function TenantUsersPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  const { session, membership, memberships } = await requireTenantAdmin(tenantId);
  if (!membership) {
    return <TenantSelector memberships={memberships} />;
  }

  return (
    <UsersClient
      currentUserId={session.user.id}
      tenantId={tenantId}
      tenantName={membership.tenant.name}
    />
  );
}
