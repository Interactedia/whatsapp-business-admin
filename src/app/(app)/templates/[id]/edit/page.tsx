import { redirect, notFound } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { componentsToBuilder, type ApiComponent, type TemplateCategory } from "@/lib/whatsapp/template-types";
import { TemplateWizard } from "../../wizard";

export default async function EditTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (session?.user.role !== "ADMIN") redirect("/");

  const { id } = await params;
  const template = await prisma.template.findUnique({ where: { id } });
  if (!template) notFound();

  const builder = componentsToBuilder(template.components as unknown as ApiComponent[], {
    name: template.name,
    language: template.language,
    category: template.category as TemplateCategory,
  });

  return <TemplateWizard initial={builder} templateId={template.id} tenantId={template.tenantId} />;
}
