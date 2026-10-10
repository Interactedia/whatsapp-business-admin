import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/me/memberships
 * Returns the memberships for the authenticated user.
 * Used by the organization selector in the app header.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const memberships = await prisma.tenantMembership.findMany({
    where: {
      userId: session.user.id,
      user: { active: true },
    },
    select: {
      id: true,
      tenantId: true,
      tenant: {
        select: { id: true, name: true },
      },
    },
    orderBy: { tenant: { name: "asc" } },
  });

  return NextResponse.json(memberships);
}
