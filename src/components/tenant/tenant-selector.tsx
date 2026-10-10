"use client";

import { useRouter } from "next/navigation";
import { Building2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shell/page-header";

export type TenantMembership = {
  id: string;
  tenantId: string;
  tenant: { id: string; name: string };
};

export function TenantSelector({
  memberships,
  resource = "contacts",
}: {
  memberships: TenantMembership[];
  resource?: "contacts" | "conversations";
}) {
  const router = useRouter();
  const resourceHref =
    resource === "conversations" ? "conversations" : "contacts";
  const resourceTitle =
    resource === "conversations" ? "Conversations" : "Contacts";

  if (memberships.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title={resourceTitle}
          description="You do not have access to any tenants."
        />
        <div className="flex flex-1 items-center justify-center p-6">
          <Card className="max-w-sm text-center">
            <CardContent className="pt-6">
              <Building2 className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No tenant access found. Contact your administrator to be added to a tenant.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={resourceTitle}
        description={`Select a tenant to view ${resourceHref}.`}
      />
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="grid w-full max-w-md gap-3">
          <p className="text-sm text-muted-foreground">
            {`Choose a tenant to access ${resourceHref}:`}
          </p>
          {memberships.map((m) => (
            <Card
              key={m.id}
              className="cursor-pointer transition-colors hover:border-primary/40"
            >
              <CardContent className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3">
                  <Building2 className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{m.tenant.name}</p>
                    <p className="text-xs text-muted-foreground">{m.tenant.id}</p>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => router.push(`/t/${m.tenantId}/${resourceHref}`)}
                >
                  Open
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
