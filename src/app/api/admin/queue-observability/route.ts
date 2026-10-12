import { handle, HttpError, ok, requireAdmin } from "@/lib/api";
import { collectOutboxObservability } from "@/lib/outbox/observability";
import { collectQueueObservability } from "@/lib/queue/observability";

export const GET = handle(async () => {
  const session = await requireAdmin();
  if (session.user.role !== "SYSTEM_ADMIN") {
    throw new HttpError(403, "System administrators only");
  }

  const [queues, database] = await Promise.all([
    collectQueueObservability(),
    collectOutboxObservability(),
  ]);

  return ok({
    queues,
    database,
    notes: {
      queueCompletion: "BullMQ completed jobs are execution signals, not Meta delivery evidence.",
      outboxPublished: "Published outbox events mean queue publication succeeded, not external message delivery.",
      uncertain: "UNCERTAIN outbound attempts are external outcome unknown and are not safe to retry automatically.",
    },
  });
});
