"use client";

import { ContactsClient } from "@/app/(app)/contacts/contacts-client";

export function TenantContactsClient({
  tenant,
  isAdmin,
}: {
  tenant: { id: string; name: string };
  isAdmin: boolean;
}) {
  return (
    <div className="flex h-full flex-col">
      {/* Contacts list — reads from tenant-scoped API */}
      <div className="flex-1 overflow-auto">
        <ContactsClient
          isAdmin={isAdmin}
          baseUrl={`/api/tenants/${tenant.id}/contacts`}
          conversationsHref={`/t/${tenant.id}/conversations`}
        />
      </div>
    </div>
  );
}
