import { prisma } from "@/lib/prisma";
import type { OutboxInspectionSummary } from "./contracts";
import type { OutboxPrisma } from "./repository";

export async function inspectOutbox(db: OutboxPrisma = prisma, now = new Date()): Promise<OutboxInspectionSummary> {
  const [counts, oldest, expired] = await Promise.all([
    db.$queryRaw<{ state: string; count: bigint }[]>`
      SELECT "state", COUNT(*) AS count FROM "OutboxEvent" GROUP BY "state"
    `,
    db.$queryRaw<{ createdAt: Date }[]>`
      SELECT "createdAt" FROM "OutboxEvent"
      WHERE "state" IN ('PENDING'::"OutboxPublicationState", 'RETRYABLE'::"OutboxPublicationState")
      ORDER BY "createdAt" ASC LIMIT 1
    `,
    db.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count FROM "OutboxEvent"
      WHERE "state" = 'CLAIMED'::"OutboxPublicationState" AND "claimExpiresAt" <= ${now}
    `,
  ]);

  const summary: OutboxInspectionSummary = {
    pending: 0,
    claimed: 0,
    published: 0,
    retryable: 0,
    terminal: 0,
    expiredLeases: Number(expired[0]?.count ?? 0n),
    oldestPendingAgeMs: oldest[0] ? now.getTime() - oldest[0].createdAt.getTime() : null,
  };

  for (const row of counts) {
    const value = Number(row.count);
    if (row.state === "PENDING") summary.pending = value;
    if (row.state === "CLAIMED") summary.claimed = value;
    if (row.state === "PUBLISHED") summary.published = value;
    if (row.state === "RETRYABLE") summary.retryable = value;
    if (row.state === "TERMINAL") summary.terminal = value;
  }
  return summary;
}
