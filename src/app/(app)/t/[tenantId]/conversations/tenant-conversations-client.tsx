"use client";

import { InboxClient } from "@/app/(app)/inbox/inbox-client";

// WA-UI-013-R1: la franja con el nombre del tenant se eliminó — el
// OrganizationSelector del encabezado global ya identifica y permite
// cambiar de tenant, y el Inbox usa todo el alto del workspace.
// WA-UI-014: se agregó currentUserId para filtrar "Mis conversaciones".
export function TenantConversationsClient({ tenantId, currentUserId }: { tenantId: string; currentUserId: string }) {
  return (
    <div className="h-full overflow-hidden">
      <InboxClient
        conversationsUrl={`/api/tenants/${tenantId}/conversations`}
        basePath={`/t/${tenantId}/conversations`}
        currentUserId={currentUserId}
      />
    </div>
  );
}
