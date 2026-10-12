import { TenantSelector } from "@/components/tenant/tenant-selector";
import { requireWebhookDestinationAdmin } from "@/lib/tenant/page-guards";
import { WebhookDestinationsClient } from "./webhook-destinations-client";

export default async function TenantWebhookDestinationsPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const { authorized, memberships } = await requireWebhookDestinationAdmin(tenantId);
  if (!authorized) return <TenantSelector memberships={memberships} />;
  return <WebhookDestinationsClient tenantId={tenantId} />;
}
