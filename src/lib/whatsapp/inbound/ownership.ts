import { prisma } from "@/lib/prisma";

export type InboundOwnership = {
  tenantId: string | null;
  wabaId: string | null;
  phoneId: string | null;
};

type Value = {
  metadata?: { phone_number_id?: string };
  statuses?: unknown[];
  messages?: unknown[];
};

export async function resolveInboundOwnership(payload: unknown): Promise<InboundOwnership> {
  try {
    const root = payload as { entry?: { changes?: { value?: Value }[] }[] };
    for (const entry of root.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const meta = change.value?.metadata?.phone_number_id;
        if (meta) {
          const phone = await prisma.phoneNumber.findFirst({
            where: { metaPhoneNumberId: meta },
            include: { wabaAccount: { select: { id: true, tenantId: true, metaWabaId: true } } },
          });
          if (phone) {
            return {
              tenantId: phone.wabaAccount.tenantId,
              wabaId: phone.wabaAccount.metaWabaId,
              phoneId: phone.id,
            };
          }
        }
      }
    }
  } catch {
    // Ownership resolution must never block webhook recording.
  }
  return { tenantId: null, wabaId: null, phoneId: null };
}
