import { Queue } from "bullmq";
import { prisma } from "@/lib/prisma";
import { QUEUE_NAMES, getBullMQConnectionOptions, getQueueConfig } from "@/lib/queue";

export async function assertOutboundConsumerReady(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
  const queue = new Queue(QUEUE_NAMES.OUTBOUND_MESSAGE, {
    connection: getBullMQConnectionOptions(),
    prefix: getQueueConfig().prefix,
  });
  try {
    const workers = await queue.getWorkers();
    if (workers.length < 1) throw new Error("No outbound BullMQ worker is registered");
  } finally {
    await queue.close();
  }
}
