import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { collectOutboxObservability } from "@/lib/outbox/observability";
import { collectQueueObservability } from "@/lib/queue/observability";
import { QueueObservabilityClient } from "./queue-observability-client";

export default async function QueueObservabilityPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "SYSTEM_ADMIN") redirect("/");

  const [queues, database] = await Promise.all([
    collectQueueObservability(),
    collectOutboxObservability(),
  ]);

  return <QueueObservabilityClient queues={queues} database={database} />;
}
