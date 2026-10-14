import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { LogsClient } from "@/app/(app)/logs/logs-client";

/**
 * System-wide API and webhook logs.
 * Only SYSTEM_ADMIN may access this page; tenant ADMIN and AGENT are redirected.
 * Logs are sourced from existing ApiLog and WebhookEvent records.
 * Suspense: LogsClient reads ?tab= for deep links from the admin dashboard.
 */
export default async function LogsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "SYSTEM_ADMIN") redirect("/");

  return (
    <Suspense>
      <LogsClient />
    </Suspense>
  );
}
