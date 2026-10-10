import { z } from "zod";
import { resolveApiKeyTenantContext } from "@/lib/tenant";
import { apiOk, requireApiKey, v1Handle } from "@/lib/v1";
import { launchFlow } from "@/lib/whatsapp/flow-launch";

const schema = z.object({
  apikey: z.string().optional(),
  to: z.string().regex(/^\d{7,15}$/),
  cta: z.string().min(1).max(20).optional(),
  body: z.string().min(1).max(1024).optional(),
  header: z.string().max(60).optional(),
  footer: z.string().max(60).optional(),
  entry_screen: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const POST = v1Handle(async (req, { params }) => {
  const body = schema.parse(await req.json());
  const context = await resolveApiKeyTenantContext(await requireApiKey(req, body));
  const result = await launchFlow({ flowId: (await params).id, tenantId: context.tenantId, to: body.to, cta: body.cta, body: body.body, header: body.header, footer: body.footer, entryScreen: body.entry_screen, initialData: body.data });
  return apiOk({ launch_id: result.launchId, message_id: result.messageId, conversation_id: result.conversationId }, 201);
});
