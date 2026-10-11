import { describe, expect, it, vi, beforeEach } from "vitest";
import { dispatchBroadcast } from "@/lib/whatsapp/broadcast/dispatcher";
import type { OutboxPrisma } from "@/lib/outbox";

describe("broadcast dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws 404 when broadcast is not found", async () => {
    const mockDb = {
      broadcast: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as OutboxPrisma;

    await expect(dispatchBroadcast("b_nonexistent", mockDb)).rejects.toMatchObject({
      status: 404,
      message: "Broadcast not found",
    });
  });

  it("throws 403 when broadcast has null tenant or template tenant mismatch", async () => {
    const mockDb1 = {
      broadcast: {
        findUnique: vi.fn().mockResolvedValue({
          id: "b1",
          tenantId: null,
          template: { tenantId: "t1" },
        }),
      },
    } as unknown as OutboxPrisma;

    await expect(dispatchBroadcast("b1", mockDb1)).rejects.toMatchObject({
      status: 403,
      message: "Broadcast tenant mismatch.",
    });

    const mockDb2 = {
      broadcast: {
        findUnique: vi.fn().mockResolvedValue({
          id: "b2",
          tenantId: "t1",
          template: { tenantId: "t2" },
        }),
      },
    } as unknown as OutboxPrisma;

    await expect(dispatchBroadcast("b2", mockDb2)).rejects.toMatchObject({
      status: 403,
      message: "Broadcast tenant mismatch.",
    });
  });

  it("throws 400 when template is not approved", async () => {
    const mockDb = {
      broadcast: {
        findUnique: vi.fn().mockResolvedValue({
          id: "b1",
          tenantId: "t1",
          template: { tenantId: "t1", status: "PENDING" },
        }),
      },
    } as unknown as OutboxPrisma;

    await expect(dispatchBroadcast("b1", mockDb)).rejects.toMatchObject({
      status: 400,
      message: "Broadcast template must be approved.",
    });
  });

  it("throws 400 when broadcast is cancelled", async () => {
    const mockDb = {
      broadcast: {
        findUnique: vi.fn().mockResolvedValue({
          id: "b1",
          tenantId: "t1",
          status: "CANCELLED",
          template: { tenantId: "t1", status: "APPROVED" },
        }),
      },
    } as unknown as OutboxPrisma;

    await expect(dispatchBroadcast("b1", mockDb)).rejects.toMatchObject({
      status: 400,
      message: "Cannot dispatch cancelled broadcast.",
    });
  });

  it("atomically creates outbox events for pending recipients", async () => {
    const broadcast = {
      id: "b1",
      tenantId: "t1",
      status: "DRAFT",
      total: 2,
      template: { id: "tpl1", tenantId: "t1", status: "APPROVED" },
      recipients: [
        { id: "r1", contactId: "c1", status: "PENDING" },
        { id: "r2", contactId: "c2", status: "PENDING" },
      ],
    };

    const insertedEvents: unknown[][] = [];
    const mockTx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      broadcast: {
        update: vi.fn().mockResolvedValue({ ...broadcast, status: "RUNNING" }),
      },
      outboxEvent: {
        create: vi.fn(),
      },
    };

    const mockDb = {
      broadcast: {
        findUnique: vi.fn().mockResolvedValue(broadcast),
      },
      wabaAccount: {
        findFirst: vi.fn().mockResolvedValue({ id: "waba1" }),
      },
      $transaction: vi.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
        return callback({
          ...mockTx,
          $queryRaw: vi.fn().mockImplementation(async (strings: TemplateStringsArray | string[], ...values: unknown[]) => {
            const raw = String(strings);
            if (raw.includes("INSERT INTO \"OutboxEvent\"")) {
              insertedEvents.push(values);
              return [{
                id: "outbox_1",
                tenantId: "t1",
                eventType: "broadcast.dispatch",
                contractVersion: 1,
                payload: values[4],
                maxAttempts: 5,
                attemptCount: 0,
                nextAttemptAt: new Date(),
                createdAt: new Date(),
                updatedAt: new Date(),
                state: "PENDING",
              }];
            }
            return [];
          }),
        });
      }),
    } as unknown as OutboxPrisma;

    const result = await dispatchBroadcast("b1", mockDb);

    expect(result.broadcastId).toBe("b1");
    expect(result.dispatchedCount).toBe(2);
    expect(result.skippedCount).toBe(0);
    expect(insertedEvents.length).toBe(2);
  });
});
