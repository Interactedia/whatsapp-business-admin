import { z } from "zod";
import { handle, ok, fail } from "@/lib/api";
import { auth } from "@/auth";
import { resolveTenantContext, TenantAuthorizationError } from "@/lib/tenant";
import { tenantMessagingRepository, type ContactListPagination } from "@/lib/tenant/repository";

/** Fields exposed to authorized tenant members. */
type ContactRead = {
  id: string;
  waId: string;
  name: string | null;
  profileName: string | null;
  tags: string[];
  notes: string | null;
  lastInboundAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  conversation?: { id: string } | null;
};

function toContactRead(raw: unknown): ContactRead | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") return null;
  const convs = Array.isArray(r.conversations) ? (r.conversations as { id: string }[]) : [];
  return {
    id: r.id as string,
    waId: (r.waId as string) ?? "",
    name: r.name as string | null,
    profileName: r.profileName as string | null,
    tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
    notes: r.notes as string | null,
    lastInboundAt: r.lastInboundAt as Date | null,
    createdAt: r.createdAt as Date,
    updatedAt: r.updatedAt as Date,
    conversation: convs[0] ?? null,
  };
}

export const GET = handle(async (req, { params }) => {
  // A. Authenticate
  const session = await auth();
  if (!session?.user) {
    return fail(401, "Unauthorized");
  }

  // B. Server-verified principal
  const principal = { userId: session.user.id };

  // C. Read tenantId from URL
  const { tenantId } = await params;

  // D. Validate membership and resolve trusted TenantContext
  let context;
  try {
    context = await resolveTenantContext(principal, tenantId);
  } catch (err) {
    if (err instanceof TenantAuthorizationError) {
      return fail(403, "Tenant access denied");
    }
    throw err;
  }

  // E. Parse query params for pagination and search
  const url = new URL(req.url);
  const search = url.searchParams.get("search")?.trim();
  const pagination: ContactListPagination = {
    take: Math.min(Number(url.searchParams.get("take")) || 200, 200),
    cursor: url.searchParams.get("cursor") || undefined,
    ...(search ? { search } : {}),
  };

  // F. Invoke tenant-scoped repository — only returns contacts owned by verified tenant
  let rawContacts: unknown[];
  try {
    rawContacts = await tenantMessagingRepository.listContacts(context, pagination);
  } catch (err) {
    if (err instanceof TenantAuthorizationError) {
      return fail(400, "Invalid request");
    }
    throw err;
  }

  // G. Return bounded response with explicitly allowlisted fields
  const contacts = rawContacts.map(toContactRead).filter((c): c is ContactRead => c !== null);

  return ok(contacts);
});

const createSchema = z.object({
  waId: z.string().trim().regex(/^\d{7,15}$/, "Enter digits only, no + (e.g. 919812345678)"),
  name: z.string().trim().optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

export const POST = handle(async (req, { params }) => {
  // A. Authenticate
  const session = await auth();
  if (!session?.user) {
    return fail(401, "Unauthorized");
  }

  // B. Server-verified principal
  const principal = { userId: session.user.id };

  // C. Read tenantId from URL
  const { tenantId } = await params;

  // D. Validate membership and resolve trusted TenantContext
  let context;
  try {
    context = await resolveTenantContext(principal, tenantId);
  } catch (err) {
    if (err instanceof TenantAuthorizationError) {
      return fail(403, "Tenant access denied");
    }
    throw err;
  }

  // E. Parse and validate input
  let body;
  try {
    body = createSchema.parse(await req.json());
  } catch {
    return fail(400, "Invalid request");
  }

  // F. Create contact with tenant ownership from trusted context
  let raw;
  try {
    raw = await tenantMessagingRepository.createContact(context, body);
  } catch (err) {
    // Handle unique constraint violation (waId already exists)
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return fail(409, "A contact with that number already exists.");
    }
    throw err;
  }

  // G. Return bounded response
  const contact = toContactRead(raw);
  if (!contact) {
    return fail(500, "Internal error");
  }

  return ok(contact, 201);
});
