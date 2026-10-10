import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { assertTrustedTenantContext, TenantAuthorizationError, type TenantContext } from "@/lib/tenant";

const idSchema = z.string().trim().min(1).max(191);
const paginationSchema = z.object({
  take: z.number().int().min(1).max(200).default(200),
  cursor: z.string().trim().min(1).max(191).optional(),
});

export type MessageListPagination = z.input<typeof paginationSchema>;

export type TenantPrisma = {
  contact: { findFirst(args: unknown): Promise<unknown> };
  conversation: { findFirst(args: unknown): Promise<unknown> };
  message: {
    findFirst(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown[]>;
  };
};

function tenantId(context: TenantContext): string {
  assertTrustedTenantContext(context);
  return context.tenantId;
}

function parseId(id: string): string {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) throw new TenantAuthorizationError();
  return parsed.data;
}

function parsePagination(pagination: MessageListPagination = {}) {
  const parsed = paginationSchema.safeParse(pagination);
  if (!parsed.success) throw new TenantAuthorizationError();
  return parsed.data;
}

export function createTenantMessagingRepository(db: TenantPrisma = prisma) {
  return {
    async findContact(context: TenantContext, id: string) {
      return db.contact.findFirst({
        where: { id: parseId(id), tenantId: tenantId(context) },
      });
    },

    async findConversation(context: TenantContext, id: string) {
      return db.conversation.findFirst({
        where: {
          id: parseId(id),
          tenantId: tenantId(context),
          contact: { tenantId: tenantId(context) },
        },
        include: { contact: true },
      });
    },

    async findMessage(context: TenantContext, id: string) {
      return db.message.findFirst({
        where: {
          id: parseId(id),
          tenantId: tenantId(context),
          conversation: {
            tenantId: tenantId(context),
            contact: { tenantId: tenantId(context) },
          },
        },
        include: { conversation: { include: { contact: true } } },
      });
    },

    async listConversationMessages(
      context: TenantContext,
      conversationId: string,
      pagination: MessageListPagination = {},
    ) {
      const tenant = tenantId(context);
      const id = parseId(conversationId);
      const { take, cursor } = parsePagination(pagination);

      const conversation = await db.conversation.findFirst({
        where: { id, tenantId: tenant, contact: { tenantId: tenant } },
        select: { id: true },
      });
      if (!conversation) return [];

      return db.message.findMany({
        where: {
          conversationId: id,
          tenantId: tenant,
          conversation: {
            tenantId: tenant,
            contact: { tenantId: tenant },
          },
        },
        orderBy: [{ timestamp: "asc" }, { id: "asc" }],
        take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
    },
  };
}

export const tenantMessagingRepository = createTenantMessagingRepository();
