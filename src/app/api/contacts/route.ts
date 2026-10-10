import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { handle, ok, requireUser, HttpError } from "@/lib/api";

const createSchema = z.object({
  waId: z.string().trim().regex(/^\d{7,15}$/, "Enter digits only, no + (e.g. 919812345678)"),
  name: z.string().trim().optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

export const POST = handle(async (req) => {
  await requireUser();
  const body = createSchema.parse(await req.json());
  const exists = await prisma.contact.findUnique({ where: { waId: body.waId } });
  if (exists) throw new HttpError(409, "A contact with that number already exists.");
  const contact = await prisma.contact.create({
    data: { waId: body.waId, name: body.name, tags: body.tags ?? [], notes: body.notes },
  });
  return ok(contact, 201);
});
