#!/usr/bin/env tsx
import "dotenv/config";
import { prisma } from "@/lib/prisma";

const now = new Date();
const [api, webhook] = await prisma.$transaction([
  prisma.apiLog.updateMany({
    where: { payloadExpiresAt: { lt: now } },
    data: { requestBody: undefined, responseBody: undefined, requestHeaders: undefined, responseHeaders: undefined },
  }),
  prisma.webhookEvent.updateMany({
    where: { payloadExpiresAt: { lt: now } },
    data: { payload: {}, headers: undefined },
  }),
]);

console.log(JSON.stringify({ apiPayloadsPurged: api.count, webhookPayloadsPurged: webhook.count }));
await prisma.$disconnect();
