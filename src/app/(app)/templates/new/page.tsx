import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { TemplateWizard } from "../wizard";

async function getFirstTenantId(userId: string): Promise<string | null> {
  const m = await prisma.tenantMembership.findFirst({
    where: { userId, user: { active: true } },
    orderBy: { createdAt: "asc" },
    select: { tenantId: true },
  });
  return m?.tenantId ?? null;
}

export default async function NewTemplatePage() {
  const session = await auth();
  if (session?.user.role !== "ADMIN") redirect("/");
  const tenantId = await getFirstTenantId(session.user.id);
  return <TemplateWizard tenantId={tenantId} />;
}
