import { prisma } from "@/lib/prisma";
import { handle, ok, requireUser, requireAdmin, HttpError } from "@/lib/api";
import { buildValidatedComponents, submitTemplate } from "@/lib/whatsapp/template-service";
import type { TemplateBuilder } from "@/lib/whatsapp/template-types";

export const GET = handle(async (req) => {
  await requireUser();
  const url = new URL(req.url);
  const onlyApproved = url.searchParams.get("approved") === "true";
  const templates = await prisma.template.findMany({
    where: onlyApproved ? { status: "APPROVED" } : undefined,
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      language: true,
      category: true,
      status: true,
      rejectionReason: true,
      metaTemplateId: true,
      components: true,
      updatedAt: true,
    },
  });
  return ok(templates);
});

export const POST = handle(async (req) => {
  const session = await requireAdmin();
  const body = (await req.json()) as { builder: TemplateBuilder; submit?: boolean; tenantId?: string };
  const builder = body.builder;

  // Validate + convert (throws 422 with all messages if invalid).
  const components = buildValidatedComponents(builder);

  const existing = await prisma.template.findUnique({
    where: { name_language: { name: builder.name, language: builder.language } },
  });
  if (existing) throw new HttpError(409, "A template with that name and language already exists.");

  const template = await prisma.template.create({
    data: {
      name: builder.name,
      language: builder.language,
      category: builder.category,
      status: "LOCAL",
      components: components as object,
      createdById: session.user.id,
      ...(body.tenantId ? { tenantId: body.tenantId } : {}),
    },
  });

  if (body.submit) {
    const result = await submitTemplate(template.id);
    return ok({ id: template.id, status: result.status, metaId: result.metaId }, 201);
  }

  return ok({ id: template.id, status: template.status }, 201);
});
