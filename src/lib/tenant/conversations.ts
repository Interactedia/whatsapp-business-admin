import { prisma } from "@/lib/prisma";
import { assertTrustedTenantContext, TenantAuthorizationError, type TenantContext } from "@/lib/tenant";
import { resolveTenantPhoneNumber } from "@/lib/tenant/waba";

export async function createTenantConversation(input: {
  context: TenantContext;
  contactId: string;
  phoneNumberId: string;
}) {
  assertTrustedTenantContext(input.context);
  const phone = await resolveTenantPhoneNumber(input.context, input.phoneNumberId);
  const contact = await prisma.contact.findFirst({
    where: { id: input.contactId, tenantId: input.context.tenantId },
    select: { id: true },
  });
  if (!contact) throw new TenantAuthorizationError();
  return createBoundConversation(input.context, contact.id, phone.id);
}

export async function startTenantConversation(input: {
  context: TenantContext;
  waId: string;
  name?: string;
  phoneNumberId: string;
}) {
  assertTrustedTenantContext(input.context);
  const phone = await resolveTenantPhoneNumber(input.context, input.phoneNumberId);
  const existingContact = await prisma.contact.findUnique({ where: { waId: input.waId } });
  const contact = existingContact
    ? await prisma.contact.update({
        where: { id: existingContact.id },
        data: input.name ? { name: input.name } : {},
      })
    : await prisma.contact.create({
        data: { waId: input.waId, name: input.name ?? null, tenantId: input.context.tenantId },
      });
  if (contact.tenantId !== input.context.tenantId) throw new TenantAuthorizationError();
  return createBoundConversation(input.context, contact.id, phone.id);
}

async function createBoundConversation(context: TenantContext, contactId: string, phoneNumberId: string) {
  const existing = await prisma.conversation.findUnique({ where: { contactId } });
  if (existing) {
    if (existing.tenantId !== context.tenantId) throw new TenantAuthorizationError();
    if (existing.phoneNumberId !== phoneNumberId) throw new TenantAuthorizationError("Conversation sender mismatch");
    return existing;
  }

  return prisma.conversation.create({
    data: { tenantId: context.tenantId, contactId, phoneNumberId },
  });
}
