import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { assertTrustedTenantContext, TenantAuthorizationError, type TenantContext } from "@/lib/tenant";

const idSchema = z.string().trim().min(1).max(191);
const paginationSchema = z.object({
  take: z.number().int().min(1).max(200).default(200),
  cursor: z.string().trim().min(1).max(191).optional(),
});

export type MessageListPagination = z.input<typeof paginationSchema>;

const contactListSchema = paginationSchema.extend({
  search: z.string().trim().max(500).optional(),
});

export type ContactListPagination = z.input<typeof contactListSchema>;

const conversationListSchema = paginationSchema.extend({
  search: z.string().trim().max(500).optional(),
});

export type ConversationListPagination = z.input<typeof conversationListSchema>;

export type TenantPrisma = {
  contact: {
    findFirst(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown[]>;
    create(args: unknown): Promise<unknown>;
    upsert(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<{ count: number }>;
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
  conversation: {
    findFirst(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown[]>;
    create?(args: unknown): Promise<unknown>;
    upsert(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
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

    async listContacts(context: TenantContext, pagination: ContactListPagination = {}) {
      const tenant = tenantId(context);
      const parsed = contactListSchema.safeParse(pagination);
      if (!parsed.success) throw new TenantAuthorizationError();
      const { take, cursor, search } = parsed.data;

      return db.contact.findMany({
        where: {
          tenantId: tenant,
          ...(search
            ? {
                OR: [
                  { name: { contains: search, mode: "insensitive" as const } },
                  { profileName: { contains: search, mode: "insensitive" as const } },
                  { waId: { contains: search } },
                ],
              }
            : undefined),
        },
        orderBy: { updatedAt: "desc" },
        take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: { conversation: { select: { id: true } } },
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

    async listConversations(context: TenantContext, pagination: ConversationListPagination = {}) {
      const tenant = tenantId(context);
      const parsed = conversationListSchema.safeParse(pagination);
      if (!parsed.success) throw new TenantAuthorizationError();
      const { take, cursor, search } = parsed.data;

      return db.conversation.findMany({
        where: {
          tenantId: tenant,
          contact: {
            tenantId: tenant,
            ...(search
              ? {
                  OR: [
                    { name: { contains: search, mode: "insensitive" as const } },
                    { profileName: { contains: search, mode: "insensitive" as const } },
                    { waId: { contains: search } },
                  ],
                }
              : undefined),
          },
        },
        orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
        take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
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

    async createContact(context: TenantContext, data: { waId: string; name?: string; tags?: string[]; notes?: string }) {
      const tenant = tenantId(context);
      const id = parseId(data.waId); // validates non-empty
      void id; // waId validation is separate
      return db.contact.create({
        data: {
          tenantId: tenant,
          waId: data.waId,
          name: data.name ?? null,
          tags: data.tags ?? [],
          notes: data.notes ?? null,
        },
      });
    },

    async updateContact(
      context: TenantContext,
      id: string,
      data: { name?: string | null; tags?: string[]; notes?: string | null },
    ) {
      const contactId = parseId(id);
      const ownerTenantId = tenantId(context);
      const result = await db.contact.updateMany({
        where: { id: contactId, tenantId: ownerTenantId },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.tags !== undefined ? { tags: data.tags } : {}),
          ...(data.notes !== undefined ? { notes: data.notes } : {}),
        },
      });
      if (result.count !== 1) return null;
      return this.findContact(context, contactId);
    },

    async deleteContact(context: TenantContext, id: string) {
      const contactId = parseId(id);
      const result = await db.contact.deleteMany({
        where: { id: contactId, tenantId: tenantId(context) },
      });
      if (result.count !== 1) return null;
      return { deleted: true };
    },

    /**
     * Get or create a Contact + Conversation pair, both owned by the verified tenant.
     * Uses upsert semantics: existing null-owned resources are NOT claimed.
     * Returns the Conversation (not the Contact) to match the inbox thread flow.
     */
    async createConversation(context: TenantContext, data: { waId: string; name?: string }) {
      const tenant = tenantId(context);
      // Upsert contact with explicit tenant ownership.
      const contact = await db.contact.upsert({
        where: { tenantId_waId: { tenantId: tenant, waId: data.waId } },
        update: data.name ? { name: data.name } : {},
        create: {
          waId: data.waId,
          name: data.name ?? null,
          tenantId: tenant,
        },
      }) as { id: string; tenantId: string | null };
      // Only upsert a conversation for contacts owned by this tenant.
      if (contact.tenantId !== tenant) {
        throw new TenantAuthorizationError();
      }
      const existingConv = await db.conversation.findFirst({
        where: { tenantId: tenant, contactId: contact.id },
      });
      const conversation = existingConv ?? (db.conversation.create
        ? await db.conversation.create({
            data: {
              contactId: contact.id,
              tenantId: tenant,
            },
          })
        : await db.conversation.upsert({
            where: { contactId: contact.id },
            update: {},
            create: {
              contactId: contact.id,
              tenantId: tenant,
            },
          }));
      return { conversation, contact };
    },

    /**
     * Update conversation fields (status, unreadCount, assignedUserId).
     * Enforces conversation ownership at mutation time.
     */
    async updateConversation(
      context: TenantContext,
      id: string,
      data: { status?: "OPEN" | "CLOSED"; unreadCount?: number; assignedUserId?: string | null },
    ) {
      const conversationId = parseId(id);
      const ownerTenantId = tenantId(context);
      const result = await db.conversation.updateMany({
        where: {
          id: conversationId,
          tenantId: ownerTenantId,
          contact: { tenantId: ownerTenantId },
        },
        data: {
          ...(data.status !== undefined ? { status: data.status } : {}),
          ...(data.unreadCount !== undefined ? { unreadCount: data.unreadCount } : {}),
          ...(data.assignedUserId !== undefined ? { assignedUserId: data.assignedUserId } : {}),
        },
      });
      if (result.count !== 1) return null;
      return this.findConversation(context, conversationId);
    },
  };
}

export const tenantMessagingRepository = createTenantMessagingRepository();
