import { handle, ok, fail } from "@/lib/api";
import { auth } from "@/auth";
import { resolveTenantContext, TenantAuthorizationError } from "@/lib/tenant";
import { tenantMessagingRepository } from "@/lib/tenant/repository";

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
};

function toContactRead(raw: unknown): ContactRead | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  // Explicitly allowlist fields — do not serialize entire Prisma model
  if (typeof r.id !== "string") return null;
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
  };
}

export const GET = handle(async (_req, { params }) => {
  // A. Authenticate — requireUser from the session
  const session = await auth();
  if (!session?.user) {
    return fail(401, "Unauthorized");
  }

  // B. Resolve verified server-side principal from the session token
  // Never trust userId from URL, query, body, or headers
  const principal = { userId: session.user.id };

  // C. Read requested tenantId from URL params
  const { tenantId } = await params;

  // D. Validate tenant membership and resolve trusted TenantContext
  let context;
  try {
    context = await resolveTenantContext(principal, tenantId);
  } catch (err) {
    // Membership denial, unknown tenant, or malformed id — do not disclose details
    if (err instanceof TenantAuthorizationError) {
      return fail(403, "Tenant access denied");
    }
    throw err;
  }

  // E. Read contactId from URL params
  const { contactId } = await params;

  // F. Invoke tenant-scoped repository — returns null for unknown/cross-tenant
  const raw = await tenantMessagingRepository.findContact(context, contactId);
  if (!raw) {
    // F. Return 404 for unknown, cross-tenant, or null-owned contacts
    return fail(404, "Contact not found");
  }

  // G. Return bounded response with explicitly allowlisted fields
  const contact = toContactRead(raw);
  if (!contact) {
    // Unexpected shape — fail closed
    return fail(404, "Contact not found");
  }

  return ok(contact);
});
