import { headers } from "next/headers";
import { TenantSelector } from "@/components/tenant/tenant-selector";
import { DeveloperClient } from "@/app/(app)/developer/developer-client";
import { requireTenantAdmin, getMemberships } from "@/lib/tenant/page-guards";

export default async function TenantDeveloperPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  const { session, membership, memberships } = await requireTenantAdmin(tenantId);
  if (!membership) {
    return <TenantSelector memberships={memberships} />;
  }

  // Build base URL for API docs
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host");
  const proto = h.get("x-forwarded-proto") || "http";
  const baseUrl = host ? `${proto}://${host}` : process.env.APP_URL || "http://localhost:3000";

  const allMemberships = await getMemberships(session.user.id);

  return (
    <DeveloperClient
      baseUrl={baseUrl}
      tenants={allMemberships.map((m) => ({ id: m.tenant.id, name: m.tenant.name }))}
    />
  );
}
