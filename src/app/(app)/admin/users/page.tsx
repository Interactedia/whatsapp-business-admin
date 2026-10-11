import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { UsersClient } from "@/app/(app)/users/users-client";

/**
 * Global user administration — exclusive to SYSTEM_ADMIN.
 * Reuses the existing UsersClient without a tenant scope.
 */
export default async function AdminUsersPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "SYSTEM_ADMIN") redirect("/");

  return <UsersClient currentUserId={session.user.id} currentRole={session.user.role} />;
}
