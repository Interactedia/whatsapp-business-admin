import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { LogsClient } from "@/app/(app)/logs/logs-client";

/**
 * System-wide API and webhook logs.
 * Only SYSTEM_ADMIN may access this page; tenant ADMIN and AGENT are redirected.
 * Logs are sourced from existing ApiLog and WebhookEvent records.
 */
export default async function LogsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "SYSTEM_ADMIN") redirect("/");

  return <LogsClient />;
}
