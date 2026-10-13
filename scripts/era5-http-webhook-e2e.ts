/**
 * WA-ERA5-02 — HTTP end-to-end verification against the RUNNING ERA5 server.
 *
 * Real bytes over the wire to /api/webhook, real HMAC-SHA256 signature, real
 * rows checked in PostgreSQL. No mocks: this is the evidence that the fix works.
 */
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";

const APP_URL = "http://localhost:4030";
const APP_SECRET = process.env.TEST_APP_SECRET!;
const META_PHONE = "1449700211552418";

const checks: { label: string; ok: boolean; detail?: string }[] = [];
function check(label: string, ok: boolean, detail?: string | null) {
  checks.push({ label, ok, detail: detail ?? undefined });
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? ` | ${detail}` : ""}`);
}

/** Real base64-shaped Meta wamid — the charset the old pattern rejected. */
const RUN = Date.now().toString(36).toUpperCase();
const REAL_WAMID = `wamid.HBgN${RUN}EXAMPLEBODY+xyz/ABC==`;

function sign(body: string, secret = APP_SECRET): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

function payload(wamid: string, waId: string, body = "real meta inbound"): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: "908703308565937",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "+15550000000", phone_number_id: META_PHONE },
          contacts: [{ profile: { name: "HTTP E2E" }, wa_id: waId }],
          messages: [{
            from: waId, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)),
            type: "text", text: { body },
          }],
        },
      }],
    }],
  });
}

async function post(body: string, signature: string | null): Promise<number> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) headers["x-hub-signature-256"] = signature;
  const res = await fetch(`${APP_URL}/api/webhook`, { method: "POST", body, headers });
  return res.status;
}

async function counts(waId: string) {
  return {
    contact: await prisma.contact.count({ where: { waId } }),
    conversation: await prisma.conversation.count({ where: { contact: { waId } } }),
    message: await prisma.message.count({ where: { waMessageId: REAL_WAMID } }),
  };
}

const WAID = `521555${RUN}`;

async function main() {
  console.log(`\n=== HTTP E2E vs ${APP_URL} | wamid=${REAL_WAMID.slice(0, 30)}... ===\n`);

  const before = await counts(WAID);
  check("estado inicial limpio (sin filas para este waId)", before.contact === 0 && before.conversation === 0 && before.message === 0, JSON.stringify(before));

  // ---- 1. SIN firma: debe rechazar y no crear nada ----
  const bodyNoSig = payload(REAL_WAMID, WAID);
  const st1 = await post(bodyNoSig, null);
  await new Promise((r) => setTimeout(r, 500));
  const after1 = await counts(WAID);
  check("sin firma -> HTTP 200 (ack para que Meta no reintente)", st1 === 200, `HTTP ${st1}`);
  check("sin firma -> CERO Contact", after1.contact === 0, `contact=${after1.contact}`);
  check("sin firma -> CERO Conversation", after1.conversation === 0, `conversation=${after1.conversation}`);
  check("sin firma -> CERO Message", after1.message === 0, `message=${after1.message}`);

  // ---- 2. Firma INVÁLIDA: mismo resultado ----
  const st2 = await post(payload(REAL_WAMID, WAID), sign(payload(REAL_WAMID, WAID), "secret_de_atacante"));
  await new Promise((r) => setTimeout(r, 500));
  const after2 = await counts(WAID);
  check("firma invalida -> HTTP 200", st2 === 200, `HTTP ${st2}`);
  check("firma invalida -> CERO Contact", after2.contact === 0, `contact=${after2.contact}`);
  check("firma invalida -> CERO Message", after2.message === 0, `message=${after2.message}`);

  // ---- 3. Firma MALFORMADA ----
  const st3 = await post(payload(REAL_WAMID, WAID), "sha1=abc123");
  await new Promise((r) => setTimeout(r, 400));
  check("firma malformada -> CERO Message", (await counts(WAID)).message === 0, `HTTP ${st3}`);

  // ---- 4. Firma VÁLIDA con wamid base64 real ----
  const goodBody = payload(REAL_WAMID, WAID);
  const st4 = await post(goodBody, sign(goodBody));
  await new Promise((r) => setTimeout(r, 1500));
  const after4 = await counts(WAID);
  check("firma valida -> HTTP 200", st4 === 200, `HTTP ${st4}`);
  check("firma valida + wamid base64 -> Contact CREADO", after4.contact === 1, `contact=${after4.contact}`);
  check("firma valida + wamid base64 -> Conversation CREADA", after4.conversation === 1, `conversation=${after4.conversation}`);
  check("firma valida + wamid base64 -> Message CREADO", after4.message === 1, `message=${after4.message}`);

  const msg = await prisma.message.findUnique({ where: { waMessageId: REAL_WAMID }, include: { conversation: { include: { contact: true } } } });
  check("Message guarda el wamid VERBATIM (+ / = intactos)", msg?.waMessageId === REAL_WAMID, msg?.waMessageId);
  check("Message es IN/RECEIVED", msg?.direction === "IN" && msg?.status === "RECEIVED", `${msg?.direction}/${msg?.status}`);
  check("Conversation enlazada al Contact correcto", msg?.conversation.contact.waId === WAID);
  check("todo bajo el tenant correcto", !!msg?.tenantId, `tenantId=${msg?.tenantId}`);

  // ---- 5. Entrega DUPLICADA (retry de Meta) ----
  const st5 = await post(goodBody, sign(goodBody));
  await new Promise((r) => setTimeout(r, 1200));
  const after5 = await counts(WAID);
  check("duplicado -> HTTP 200", st5 === 200, `HTTP ${st5}`);
  check("duplicado -> NO duplica Message", after5.message === 1, `message=${after5.message}`);
  check("duplicado -> NO duplica Conversation", after5.conversation === 1, `conversation=${after5.conversation}`);
  check("duplicado -> NO duplica Contact", after5.contact === 1, `contact=${after5.contact}`);

  // ---- 6. WebhookEvent: diagnóstico estructurado, sin secretos ----
  const events = await prisma.webhookEvent.findMany({ orderBy: { createdAt: "desc" }, take: 6 });
  const rejected = events.filter((e) => !e.signatureValid);
  check("eventos rechazados quedaron registrados", rejected.length >= 2, `count=${rejected.length}`);
  const withDiagnostic = rejected.find((e) => e.error && e.error.startsWith("{"));
  check("rechazo persiste diagnóstico ESTRUCTURADO (JSON)", !!withDiagnostic, withDiagnostic?.error);
  if (withDiagnostic?.error) {
    const d = JSON.parse(withDiagnostic.error) as Record<string, string>;
    check("diagnóstico identifica stage", d.stage === "webhook.authentication", `stage=${d.stage}`);
    check("diagnóstico identifica category", d.category === "AUTH_REJECTED", `category=${d.category}`);
    check("diagnóstico identifica reason específico", ["SIGNATURE_MISSING", "SIGNATURE_MALFORMED", "SIGNATURE_INVALID"].includes(d.reason), `reason=${d.reason}`);
    check("diagnóstico tiene correlationId", !!d.correlationId, `correlationId=${d.correlationId}`);
  }
  const allErrors = events.map((e) => e.error ?? "").join("|");
  check("NINGÚN error persistido contiene el app secret", !allErrors.includes(APP_SECRET));
  check("NINGÚN error persistido contiene material de firma", !allErrors.includes("sha256="), allErrors.slice(0, 120));

  const okEvent = events.find((e) => e.signatureValid && e.processedOk);
  check("evento válido marcado processedOk=true", !!okEvent, okEvent?.eventSummary ?? undefined);

  // ---- limpieza: solo lo que este script creó ----
  if (msg) {
    await prisma.message.deleteMany({ where: { conversationId: msg.conversationId } });
    await prisma.conversation.deleteMany({ where: { id: msg.conversationId } });
  }
  await prisma.contact.deleteMany({ where: { waId: WAID } });
  await prisma.canonicalEventOutbox.deleteMany({ where: { payload: { path: ["payload", "preview"], equals: "real meta inbound" } } }).catch(() => {});

  await prisma.$disconnect();

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks HTTP E2E passed ===`);
  if (failed.length) process.exit(1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
