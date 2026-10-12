import { prisma } from "@/lib/prisma";
import { inspectOutbox } from "@/lib/outbox";
import type { OutboxPrisma } from "@/lib/outbox";

export interface OutboundAttemptStateCount {
  state: string;
  count: number;
}

export interface OutboxObservabilitySummary {
  available: true;
  outbox: Awaited<ReturnType<typeof inspectOutbox>>;
  outboundAttempts: OutboundAttemptStateCount[];
  collectedAt: string;
}

export type OutboxObservabilityResult =
  | OutboxObservabilitySummary
  | { available: false; error: string; collectedAt: string };

function sanitizeError(error: unknown): string {
  return error instanceof Error ? error.name || "DatabaseInspectionError" : "DatabaseInspectionError";
}

export async function collectOutboxObservability(db: OutboxPrisma = prisma): Promise<OutboxObservabilityResult> {
  const collectedAt = new Date().toISOString();

  try {
    const [outbox, outboundAttempts] = await Promise.all([
      inspectOutbox(db),
      db.$queryRaw<{ state: string; count: bigint }[]>`
        SELECT "state", COUNT(*) AS count FROM "OutboundSendAttempt" GROUP BY "state"
      `,
    ]);

    return {
      available: true,
      outbox,
      outboundAttempts: outboundAttempts.map((row) => ({ state: row.state, count: Number(row.count) })),
      collectedAt,
    };
  } catch (error) {
    return { available: false, error: sanitizeError(error), collectedAt };
  }
}
