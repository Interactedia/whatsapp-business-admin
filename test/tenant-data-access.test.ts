import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTenantContext, TenantAuthorizationError, type TenantContext } from "@/lib/tenant";
import { createTenantMessagingRepository, type TenantPrisma } from "@/lib/tenant/repository";

const membershipFindUnique = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMembership: { findUnique: membershipFindUnique },
    contact: { findFirst: vi.fn(), findMany: vi.fn() },
    conversation: { findFirst: vi.fn() },
    message: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));

type Row = { id: string; tenantId: string | null; [key: string]: unknown };
type Contact = Row;
type Conversation = Row & { contactId: string; contact?: Contact };
type Message = Row & { conversationId: string; timestamp: Date; conversation?: Conversation };

type Where = Record<string, unknown>;

const tenant1 = "tenant-1";
const tenant2 = "tenant-2";
const contact1: Contact = { id: "contact-1", tenantId: tenant1 };
const contact2: Contact = { id: "contact-2", tenantId: tenant2 };
const nullContact: Contact = { id: "contact-null", tenantId: null };
const conversation1: Conversation = { id: "conversation-1", tenantId: tenant1, contactId: contact1.id };
const conversation2: Conversation = { id: "conversation-2", tenantId: tenant2, contactId: contact2.id };
const mismatchedConversation: Conversation = {
  id: "conversation-mismatch",
  tenantId: tenant1,
  contactId: contact2.id,
};
const nullConversation: Conversation = {
  id: "conversation-null",
  tenantId: null,
  contactId: contact1.id,
};
const message1: Message = {
  id: "message-1",
  tenantId: tenant1,
  conversationId: conversation1.id,
  timestamp: new Date("2026-01-01T00:00:00Z"),
};
const message2: Message = {
  id: "message-2",
  tenantId: tenant2,
  conversationId: conversation2.id,
  timestamp: new Date("2026-01-01T00:00:01Z"),
};
const mismatchedMessage: Message = {
  id: "message-mismatch",
  tenantId: tenant1,
  conversationId: conversation2.id,
  timestamp: new Date("2026-01-01T00:00:02Z"),
};
const nullMessage: Message = {
  id: "message-null",
  tenantId: null,
  conversationId: conversation1.id,
  timestamp: new Date("2026-01-01T00:00:03Z"),
};

const baseContacts = [contact1, contact2, nullContact];
const baseConversations = [conversation1, conversation2, mismatchedConversation, nullConversation];
const baseMessages = [message1, message2, mismatchedMessage, nullMessage];

let contacts = [...baseContacts];
let conversations = [...baseConversations];
let messages = [...baseMessages];

function matchesContact(contact: Contact, where: Where): boolean {
  return (!where.id || contact.id === where.id) && (!where.tenantId || contact.tenantId === where.tenantId);
}

function matchesConversation(conversation: Conversation, where: Where): boolean {
  const contact = contacts.find((row) => row.id === conversation.contactId);
  const contactWhere = (where.contact as Where | undefined) ?? undefined;
  return (
    (!where.id || conversation.id === where.id) &&
    (!where.tenantId || conversation.tenantId === where.tenantId) &&
    (!contactWhere || !!contact && matchesContact(contact, contactWhere))
  );
}

function matchesMessage(message: Message, where: Where): boolean {
  const conversation = conversations.find((row) => row.id === message.conversationId);
  const conversationWhere = (where.conversation as Where | undefined) ?? undefined;
  return (
    (!where.id || message.id === where.id) &&
    (!where.conversationId || message.conversationId === where.conversationId) &&
    (!where.tenantId || message.tenantId === where.tenantId) &&
    (!conversationWhere || !!conversation && matchesConversation(conversation, conversationWhere))
  );
}

function includeConversation(conversation: Conversation, include?: unknown): Conversation {
  const contact = contacts.find((row) => row.id === conversation.contactId);
  return include && typeof include === "object" && "contact" in include && contact
    ? { ...conversation, contact }
    : conversation;
}

function includeMessage(message: Message, include?: unknown): Message {
  const conversation = conversations.find((row) => row.id === message.conversationId);
  return include && conversation ? { ...message, conversation: includeConversation(conversation, { contact: true }) } : message;
}

function fakeDb() {
  return {
    contact: {
      findFirst: vi.fn(async ({ where }: { where: Where }) => contacts.find((row) => matchesContact(row, where)) ?? null),
      findMany: vi.fn(async ({ where, take, cursor, skip }: { where: Where; take: number; cursor?: { id: string }; skip?: number }) => {
        const matched = contacts.filter((row) => matchesContact(row, where));
        const start = cursor ? Math.max(0, matched.findIndex((row) => row.id === cursor.id) + (skip ?? 0)) : 0;
        return matched.slice(start, start + take);
      }),
      create: vi.fn(async ({ data }: { data: { tenantId: string; waId: string; name?: string | null; tags?: string[]; notes?: string | null } }) => {
        const newContact: Contact = { id: `new-${data.waId}`, tenantId: data.tenantId };
        contacts.push(newContact);
        return { ...newContact, ...data, createdAt: new Date(), updatedAt: new Date() };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        const row = contacts.find((contact) => matchesContact(contact, where));
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        const idx = contacts.findIndex((contact) => matchesContact(contact, where));
        if (idx === -1) return { count: 0 };
        contacts.splice(idx, 1);
        return { count: 1 };
      }),
    },
    conversation: {
      findFirst: vi.fn(async ({ where, include, select }: { where: Where; include?: unknown; select?: unknown }) => {
        const conversation = conversations.find((row) => matchesConversation(row, where));
        if (!conversation) return null;
        if (select) return { id: conversation.id };
        return includeConversation(conversation, include);
      }),
      findMany: vi.fn(async ({ where, take, cursor, skip, include }: { where: Where; take: number; cursor?: { id: string }; skip?: number; include?: unknown }) => {
        const matched = conversations.filter((row) => matchesConversation(row, where));
        const start = cursor ? Math.max(0, matched.findIndex((row) => row.id === cursor.id) + (skip ?? 0)) : 0;
        return matched.slice(start, start + take).map((c) => includeConversation(c, include));
      }),
    },
    message: {
      findFirst: vi.fn(async ({ where, include }: { where: Where; include?: unknown }) => {
        const message = messages.find((row) => matchesMessage(row, where));
        return message ? includeMessage(message, include) : null;
      }),
      findMany: vi.fn(async ({ where, take, cursor, skip }: { where: Where; take: number; cursor?: { id: string }; skip?: number }) => {
        const matched = messages
          .filter((row) => matchesMessage(row, where))
          .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime() || a.id.localeCompare(b.id));
        const start = cursor ? Math.max(0, matched.findIndex((row) => row.id === cursor.id) + (skip ?? 0)) : 0;
        return matched.slice(start, start + take);
      }),
    },
  };
}

async function context() {
  membershipFindUnique.mockResolvedValueOnce({
    id: "membership-1",
    user: { id: "user-1", active: true },
    tenant: { id: tenant1 },
  });
  return resolveTenantContext({ userId: "user-1" }, tenant1);
}

describe("WA-01-05B tenant-scoped messaging data access", () => {
  beforeEach(() => {
    membershipFindUnique.mockReset();
    Object.assign(contact1, { id: "contact-1", tenantId: tenant1 });
    Object.assign(contact2, { id: "contact-2", tenantId: tenant2 });
    Object.assign(nullContact, { id: "contact-null", tenantId: null });
    Object.assign(nullConversation, { id: "conversation-null", tenantId: null, contactId: contact1.id });
    delete contact1.name;
    delete contact2.name;
    delete nullContact.name;
    contacts = [...baseContacts];
    conversations = [...baseConversations];
    messages = [...baseMessages];
  });

  it("reads an authorized contact", async () => {
    await expect(createTenantMessagingRepository(fakeDb() as TenantPrisma).findContact(await context(), contact1.id)).resolves.toEqual(contact1);
  });

  it("denies cross-tenant and null-owned contacts", async () => {
    const repo = createTenantMessagingRepository(fakeDb() as TenantPrisma);
    const ctx = await context();

    await expect(repo.findContact(ctx, contact2.id)).resolves.toBeNull();
    await expect(repo.findContact(ctx, nullContact.id)).resolves.toBeNull();
  });

  it("reads an authorized conversation", async () => {
    await expect(createTenantMessagingRepository(fakeDb() as TenantPrisma).findConversation(await context(), conversation1.id)).resolves.toMatchObject({
      id: conversation1.id,
      contact: contact1,
    });
  });

  it("denies cross-tenant conversations and contact ownership mismatches", async () => {
    const repo = createTenantMessagingRepository(fakeDb() as TenantPrisma);
    const ctx = await context();

    await expect(repo.findConversation(ctx, conversation2.id)).resolves.toBeNull();
    await expect(repo.findConversation(ctx, mismatchedConversation.id)).resolves.toBeNull();
  });

  it("reads an authorized message", async () => {
    await expect(createTenantMessagingRepository(fakeDb() as TenantPrisma).findMessage(await context(), message1.id)).resolves.toMatchObject({
      id: message1.id,
      conversation: { id: conversation1.id, contact: contact1 },
    });
  });

  it("denies cross-tenant, mismatched and null-owned messages", async () => {
    const repo = createTenantMessagingRepository(fakeDb() as TenantPrisma);
    const ctx = await context();

    await expect(repo.findMessage(ctx, message2.id)).resolves.toBeNull();
    await expect(repo.findMessage(ctx, mismatchedMessage.id)).resolves.toBeNull();
    await expect(repo.findMessage(ctx, nullMessage.id)).resolves.toBeNull();
  });

  it("lists only authorized conversation messages with bounded pagination", async () => {
    const db = fakeDb();
    const result = await createTenantMessagingRepository(db).listConversationMessages(await context(), conversation1.id, { take: 1 });

    expect(result).toEqual([message1]);
    expect(db.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }));
  });

  it("lists only same-tenant contacts, excluding cross-tenant and null-owned", async () => {
    const db = fakeDb();
    const ctx = await context();
    const result = await createTenantMessagingRepository(db).listContacts(ctx);

    // Only tenant-1's contact is returned — tenant-2's and null-owned are excluded
    expect(result).toEqual([contact1]);
    expect(db.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: tenant1 }) })
    );
  });

  it("lists contacts with bounded take", async () => {
    const db = fakeDb();
    const ctx = await context();
    await createTenantMessagingRepository(db).listContacts(ctx, { take: 1 });

    expect(db.contact.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }));
  });

  it("updates only same-tenant contacts at mutation time", async () => {
    const db = fakeDb();
    const repo = createTenantMessagingRepository(db as TenantPrisma);
    const ctx = await context();

    await expect(repo.updateContact(ctx, contact1.id, { name: "Updated" })).resolves.toMatchObject({
      id: contact1.id,
      tenantId: tenant1,
      name: "Updated",
    });
    expect(db.contact.updateMany).toHaveBeenCalledWith({
      where: { id: contact1.id, tenantId: tenant1 },
      data: { name: "Updated" },
    });
  });

  it("denies cross-tenant and null-owned contact updates at mutation time", async () => {
    const repo = createTenantMessagingRepository(fakeDb() as TenantPrisma);
    const ctx = await context();

    await expect(repo.updateContact(ctx, contact2.id, { name: "Nope" })).resolves.toBeNull();
    await expect(repo.updateContact(ctx, nullContact.id, { name: "Nope" })).resolves.toBeNull();
  });

  it("does not mutate when contact ownership changes before update mutation", async () => {
    const repo = createTenantMessagingRepository(fakeDb() as TenantPrisma);
    const ctx = await context();
    contact1.tenantId = tenant2;

    await expect(repo.updateContact(ctx, contact1.id, { name: "Stale" })).resolves.toBeNull();
    expect(contact1.name).toBeUndefined();
  });

  it("deletes only same-tenant contacts at mutation time", async () => {
    const db = fakeDb();
    const repo = createTenantMessagingRepository(db as TenantPrisma);
    const ctx = await context();

    await expect(repo.deleteContact(ctx, contact1.id)).resolves.toEqual({ deleted: true });
    expect(db.contact.deleteMany).toHaveBeenCalledWith({ where: { id: contact1.id, tenantId: tenant1 } });
    expect(db.conversation.findFirst).not.toHaveBeenCalled();
  });

  it("denies cross-tenant and null-owned contact deletes at mutation time", async () => {
    const repo = createTenantMessagingRepository(fakeDb() as TenantPrisma);
    const ctx = await context();

    await expect(repo.deleteContact(ctx, contact2.id)).resolves.toBeNull();
    await expect(repo.deleteContact(ctx, nullContact.id)).resolves.toBeNull();
  });

  it("does not delete when contact ownership changes before delete mutation", async () => {
    const repo = createTenantMessagingRepository(fakeDb() as TenantPrisma);
    const ctx = await context();
    contact1.tenantId = tenant2;

    await expect(repo.deleteContact(ctx, contact1.id)).resolves.toBeNull();
    expect(contacts.some((contact) => contact.id === contact1.id)).toBe(true);
  });

  it("returns null for missing contact mutations without disclosure", async () => {
    const repo = createTenantMessagingRepository(fakeDb() as TenantPrisma);
    const ctx = await context();

    await expect(repo.updateContact(ctx, "missing-contact", { name: "Missing" })).resolves.toBeNull();
    await expect(repo.deleteContact(ctx, "missing-contact")).resolves.toBeNull();
  });

  it("rejects invalid contact pagination values", async () => {
    const repo = createTenantMessagingRepository(fakeDb() as TenantPrisma);
    const ctx = await context();

    await expect(repo.listContacts(ctx, { take: 0 })).rejects.toBeInstanceOf(TenantAuthorizationError);
    await expect(repo.listContacts(ctx, { take: 999 })).rejects.toBeInstanceOf(TenantAuthorizationError);
  });

  it("rejects forged contexts for listContacts", async () => {
    const repo = createTenantMessagingRepository(fakeDb() as TenantPrisma);
    const forged = { tenantId: tenant1, userId: "user-1", membershipId: "membership-1" } as TenantContext;

    await expect(repo.listContacts(forged)).rejects.toBeInstanceOf(TenantAuthorizationError);
    await expect(repo.listContacts(null as unknown as TenantContext)).rejects.toBeInstanceOf(TenantAuthorizationError);
  });

  it("denies mixed-tenant message listing", async () => {
    const result = await createTenantMessagingRepository(fakeDb() as TenantPrisma).listConversationMessages(await context(), conversation2.id);

    expect(result).toEqual([]);
  });

  it("rejects forged and missing contexts", async () => {
    const repo = createTenantMessagingRepository(fakeDb() as TenantPrisma);
    const forged = { tenantId: tenant1, userId: "user-1", membershipId: "membership-1" } as TenantContext;

    await expect(repo.findContact(forged, contact1.id)).rejects.toBeInstanceOf(TenantAuthorizationError);
    await expect(repo.findContact(null as unknown as TenantContext, contact1.id)).rejects.toBeInstanceOf(TenantAuthorizationError);
  });

  it("rejects invalid pagination", async () => {
    await expect(
      createTenantMessagingRepository(fakeDb() as TenantPrisma).listConversationMessages(await context(), conversation1.id, { take: 0 }),
    ).rejects.toBeInstanceOf(TenantAuthorizationError);
  });

  it("does not disclose missing resources", async () => {
    const repo = createTenantMessagingRepository(fakeDb() as TenantPrisma);
    const ctx = await context();

    await expect(repo.findContact(ctx, "missing-contact")).resolves.toBeNull();
    await expect(repo.findConversation(ctx, "missing-conversation")).resolves.toBeNull();
    await expect(repo.findMessage(ctx, "missing-message")).resolves.toBeNull();
    await expect(repo.listConversationMessages(ctx, "missing-conversation")).resolves.toEqual([]);
  });

  it("lists only same-tenant conversations with owned contacts", async () => {
    const result = await createTenantMessagingRepository(fakeDb() as TenantPrisma).listConversations(await context());

    expect(result.map((c) => (c as { id: string }).id)).toEqual([conversation1.id]);
  });

  it("excludes cross-tenant, null-owned, and foreign-contact conversations from list", async () => {
    const result = await createTenantMessagingRepository(fakeDb() as TenantPrisma).listConversations(await context());
    const ids = result.map((c) => (c as { id: string }).id);

    expect(ids).not.toContain(conversation2.id);
    expect(ids).not.toContain(mismatchedConversation.id);
    expect(ids).not.toContain(nullConversation.id);
  });

  it("rejects forged contexts and invalid pagination for listConversations", async () => {
    const repo = createTenantMessagingRepository(fakeDb() as TenantPrisma);
    const ctx = await context();
    const forged = { tenantId: tenant1, userId: "user-1", membershipId: "membership-1" } as TenantContext;

    await expect(repo.listConversations(forged)).rejects.toBeInstanceOf(TenantAuthorizationError);
    await expect(repo.listConversations(null as unknown as TenantContext)).rejects.toBeInstanceOf(TenantAuthorizationError);
    await expect(repo.listConversations(ctx, { take: 0 })).rejects.toBeInstanceOf(TenantAuthorizationError);
    await expect(repo.listConversations(ctx, { take: 999 })).rejects.toBeInstanceOf(TenantAuthorizationError);
  });

  it("applies tenant filtering before pagination", async () => {
    const repo = createTenantMessagingRepository(fakeDb() as TenantPrisma);
    const ctx = await context();

    const result = await repo.listConversations(ctx, { take: 1 });

    expect(result).toHaveLength(1);
    expect((result[0] as { id: string }).id).toBe(conversation1.id);
  });
});
