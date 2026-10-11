import { prisma } from "@/lib/prisma";
import type { OutboxEventInput, OutboxEventRecord } from "./contracts";
import { insertOutboxEvent, type OutboxPrisma } from "./repository";

export async function addOutboxEvent(
  tx: OutboxPrisma,
  input: OutboxEventInput
): Promise<OutboxEventRecord> {
  return insertOutboxEvent(tx, input);
}

export async function withOutboxTransaction<T>(
  fn: (tx: OutboxPrisma, addEvent: (input: OutboxEventInput) => Promise<OutboxEventRecord>) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => fn(tx, (input) => addOutboxEvent(tx, input)));
}
