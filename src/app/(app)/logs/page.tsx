import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { LogsClient } from "@/app/(app)/logs/logs-client";

/**
 * Platform logs contain legacy global audit records without tenant ownership.
 * Until those records have proven ownership, only SYSTEM_ADMIN may view them.
 */
export default async function LogsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "SYSTEM_ADMIN") redirect("/");

  return <LogsClient />;
}
