/**
 * Seed script para fixtures de desarrollo del Inbox.
 * Genera 10 conversaciones ficticias con mensajes de prueba.
 *
 * Características:
 * - Idempotente: usar --force para recrear, sin --force preserva datos existentes
 * - Datos ficticios: números de teléfono sin capacidad real
 * - Aislamiento: solo afecta al tenant de desarrollo
 * - Sin side effects: no invoca Meta ni crea jobs BullMQ
 *
 * Uso:
 *   WBA_ALLOW_DEMO_SEED=true npx tsx scripts/seed-inbox-fixtures.ts
 *   WBA_ALLOW_DEMO_SEED=true npx tsx scripts/seed-inbox-fixtures.ts --force
 */

import { prisma } from "../src/lib/prisma";
import {
  MessageType,
  MessageStatus,
  MessageDirection,
  ConversationStatus,
} from "../src/generated/prisma/enums";

// Tenant de desarrollo autorizado
const DEV_TENANT_ID = "cmv337nob0001t25hbbyuq8tk";

// Identificador reservado para fixtures de desarrollo
const FIXTURE_PREFIX = "fixture-";

// Números de teléfono ficticios (formato E.164 sin +)
const FIXTURE_PHONES = [
  "5491100000001", // María García
  "5491100000002", // Juan Pérez
  "5491100000003", // Ana López
  "5491100000004", // Carlos Rodríguez
  "5491100000005", // Laura Fernández
  "5491100000006", // Diego Martínez
  "5491100000007", // Sofía González
  "5491100000008", // Martín Sánchez
  "5491100000009", // Valentina Torres
  "5491100000010", // Alejandro Ramírez
];

interface MessageFixture {
  direction: MessageDirection;
  type: MessageType;
  status: MessageStatus;
  text: string;
  daysAgo: number;
  hoursOffset: number;
}

interface ConversationFixture {
  phone: string;
  contactName: string;
  status: ConversationStatus;
  unreadCount: number;
  assignedUserEmail?: string;
  messages: MessageFixture[];
}

const CONVERSATION_FIXTURES: ConversationFixture[] = [
  {
    phone: FIXTURE_PHONES[0],
    contactName: "María García",
    status: "OPEN",
    unreadCount: 2,
    assignedUserEmail: "agent@default.com",
    messages: [
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "Hola, quiero consultar por el producto X", daysAgo: 0, hoursOffset: 10 },
      { direction: "OUT", type: "TEXT", status: "READ", text: "¡Hola María! Con gusto te ayudo.", daysAgo: 0, hoursOffset: 11 },
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "El producto de la semana pasada, el taladro eléctrico", daysAgo: 0, hoursOffset: 12 },
      { direction: "OUT", type: "TEXT", status: "DELIVERED", text: "Perfecto, tenemos stock disponible.", daysAgo: 0, hoursOffset: 13 },
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "Sí, por favor. ¿Llega esta semana?", daysAgo: 0, hoursOffset: 14 },
    ],
  },
  {
    phone: FIXTURE_PHONES[1],
    contactName: "Juan Pérez",
    status: "OPEN",
    unreadCount: 0,
    assignedUserEmail: "agent@default.com",
    messages: [
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "El equipo no enciende desde ayer", daysAgo: 1, hoursOffset: 9 },
      { direction: "OUT", type: "TEXT", status: "READ", text: "Lamento escuchar eso, Juan. ¿Revisaste el cable?", daysAgo: 1, hoursOffset: 10 },
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "Sí, está bien conectado", daysAgo: 1, hoursOffset: 10 },
      { direction: "OUT", type: "TEXT", status: "READ", text: "¿Escuchas algún ruido del ventilador?", daysAgo: 1, hoursOffset: 11 },
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "No, nada. Parece completamente muerto", daysAgo: 1, hoursOffset: 11 },
      { direction: "OUT", type: "TEXT", status: "DELIVERED", text: "Entiendo. Necesitaremos un caso de garantía.", daysAgo: 1, hoursOffset: 12 },
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "Sí, lo tengo. Lo busco", daysAgo: 0, hoursOffset: 8 },
      { direction: "OUT", type: "TEXT", status: "SENT", text: "Perfecto, cuando lo tengas envíamelo.", daysAgo: 0, hoursOffset: 9 },
    ],
  },
  {
    phone: FIXTURE_PHONES[2],
    contactName: "Ana López",
    status: "CLOSED",
    unreadCount: 0,
    assignedUserEmail: "agent@default.com",
    messages: [
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "Buenos días, ¿Cuáles son sus horarios?", daysAgo: 3, hoursOffset: 9 },
      { direction: "OUT", type: "TEXT", status: "READ", text: "¡Buenos días Ana! Lunes a Viernes 9 a 18hs.", daysAgo: 3, hoursOffset: 10 },
      { direction: "IN", type: "TEXT", status: "READ", text: "Gracias, ¿Abren los sábados?", daysAgo: 3, hoursOffset: 10 },
      { direction: "OUT", type: "TEXT", status: "DELIVERED", text: "Sí, los sábados de 10 a 14hs.", daysAgo: 3, hoursOffset: 11 },
    ],
  },
  {
    phone: FIXTURE_PHONES[3],
    contactName: "Carlos Rodríguez",
    status: "OPEN",
    unreadCount: 1,
    messages: [
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "Hola, necesito hacer un pedido especial", daysAgo: 2, hoursOffset: 14 },
      { direction: "OUT", type: "TEXT", status: "READ", text: "¡Hola Carlos! Claro, cuéntame.", daysAgo: 2, hoursOffset: 15 },
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "Son 50 unidades del modelo PRO", daysAgo: 2, hoursOffset: 15 },
      { direction: "OUT", type: "TEXT", status: "DELIVERED", text: "Perfecto, ¿Tienes correo para la cotización?", daysAgo: 2, hoursOffset: 16 },
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "Sí, carlos@empresa.com.ar", daysAgo: 1, hoursOffset: 9 },
      { direction: "OUT", type: "TEXT", status: "SENT", text: "Te envié la cotización. 15 días hábiles.", daysAgo: 1, hoursOffset: 17 },
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "Recibido, lo reviso y te confirmo", daysAgo: 0, hoursOffset: 10 },
    ],
  },
  {
    phone: FIXTURE_PHONES[4],
    contactName: "Laura Fernández",
    status: "OPEN",
    unreadCount: 3,
    assignedUserEmail: "agent@default.com",
    messages: [
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "Muy disgustada con mi última compra", daysAgo: 1, hoursOffset: 16 },
      { direction: "OUT", type: "TEXT", status: "READ", text: "Lamento eso, Laura. ¿Qué pasó?", daysAgo: 1, hoursOffset: 17 },
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "Llegó el producto equivocado", daysAgo: 1, hoursOffset: 17 },
      { direction: "OUT", type: "TEXT", status: "DELIVERED", text: "Disculpas. ¿Cambio o devolución?", daysAgo: 1, hoursOffset: 18 },
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "Prefiero el cambio", daysAgo: 0, hoursOffset: 9 },
      { direction: "OUT", type: "TEXT", status: "SENT", text: "Te enviamos el correcto.", daysAgo: 0, hoursOffset: 10 },
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "¿Cuándo vendrá a buscarlo?", daysAgo: 0, hoursOffset: 11 },
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "¿Y el envío del nuevo?", daysAgo: 0, hoursOffset: 12 },
    ],
  },
  {
    phone: FIXTURE_PHONES[5],
    contactName: "Diego Martínez",
    status: "CLOSED",
    unreadCount: 0,
    assignedUserEmail: "agent@default.com",
    messages: [
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "Quiero saber el estado de mi pedido #12345", daysAgo: 4, hoursOffset: 11 },
      { direction: "OUT", type: "TEXT", status: "READ", text: "Hola Diego, está en camino. Llega mañana.", daysAgo: 4, hoursOffset: 12 },
      { direction: "IN", type: "TEXT", status: "READ", text: "Perfecto, gracias", daysAgo: 4, hoursOffset: 13 },
      { direction: "OUT", type: "TEXT", status: "DELIVERED", text: "¡De nada!", daysAgo: 4, hoursOffset: 14 },
    ],
  },
  {
    phone: FIXTURE_PHONES[6],
    contactName: "Sofía González",
    status: "OPEN",
    unreadCount: 1,
    messages: [
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "Hola, necesito una cotización para 20 impresoras", daysAgo: 0, hoursOffset: 8 },
      { direction: "OUT", type: "TEXT", status: "READ", text: "¡Hola Sofía! ¿Qué modelo te interesa?", daysAgo: 0, hoursOffset: 9 },
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "La HP LaserJet Pro", daysAgo: 0, hoursOffset: 10 },
      { direction: "OUT", type: "TEXT", status: "SENT", text: "Te paso la cotización en 30 min.", daysAgo: 0, hoursOffset: 11 },
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "Estaré atenta, gracias", daysAgo: 0, hoursOffset: 12 },
    ],
  },
  {
    phone: FIXTURE_PHONES[7],
    contactName: "Martín Sánchez",
    status: "CLOSED",
    unreadCount: 0,
    assignedUserEmail: "agent@default.com",
    messages: [
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "Quiero devolver el producto de la semana pasada", daysAgo: 5, hoursOffset: 15 },
      { direction: "OUT", type: "TEXT", status: "READ", text: "Hola Martín, ¿motivo de la devolución?", daysAgo: 5, hoursOffset: 16 },
      { direction: "IN", type: "TEXT", status: "READ", text: "No era lo que esperaba", daysAgo: 5, hoursOffset: 17 },
      { direction: "OUT", type: "TEXT", status: "DELIVERED", text: "Sin problema. Te enviamos la etiqueta.", daysAgo: 5, hoursOffset: 18 },
      { direction: "IN", type: "TEXT", status: "READ", text: "Perfecto, gracias", daysAgo: 4, hoursOffset: 9 },
      { direction: "OUT", type: "TEXT", status: "DELIVERED", text: "Recibimos tu paquete. Reembolso en proceso.", daysAgo: 2, hoursOffset: 14 },
    ],
  },
  {
    phone: FIXTURE_PHONES[8],
    contactName: "Valentina Torres",
    status: "OPEN",
    unreadCount: 1,
    messages: [
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "Buenas! Los encontré por Instagram", daysAgo: 0, hoursOffset: 15 },
      { direction: "OUT", type: "TEXT", status: "READ", text: "¡Hola Valentina! Qué gusto que nos contactes.", daysAgo: 0, hoursOffset: 16 },
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "¿Tienen envío a Córdoba?", daysAgo: 0, hoursOffset: 17 },
    ],
  },
  {
    phone: FIXTURE_PHONES[9],
    contactName: "Alejandro Ramírez",
    status: "OPEN",
    unreadCount: 0,
    assignedUserEmail: "admin@default.com",
    messages: [
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "Hola, soy proveedor. ¿Trabajan con nuevos?", daysAgo: 2, hoursOffset: 10 },
      { direction: "OUT", type: "TEXT", status: "READ", text: "¡Hola Alejandro! Sí, estamos abiertos.", daysAgo: 2, hoursOffset: 11 },
      { direction: "IN", type: "TEXT", status: "RECEIVED", text: "Cables USB-C certificados", daysAgo: 2, hoursOffset: 12 },
      { direction: "OUT", type: "TEXT", status: "DELIVERED", text: "Interesante. Envíanos catálogo.", daysAgo: 2, hoursOffset: 14 },
      { direction: "IN", type: "TEXT", status: "SENT", text: "Claro, te lo envío hoy.", daysAgo: 1, hoursOffset: 9 },
    ],
  },
];

function calculateTimestamp(daysAgo: number, hoursOffset: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hoursOffset, 0, 0, 0);
  return date;
}

async function findOrCreateContact(phone: string, name: string, lastInboundAt: Date) {
  const existing = await prisma.contact.findFirst({
    where: { tenantId: DEV_TENANT_ID, waId: phone },
  });
  if (existing) {
    return prisma.contact.update({
      where: { id: existing.id },
      data: { name, lastInboundAt },
    });
  }
  return prisma.contact.create({
    data: {
      id: `${FIXTURE_PREFIX}contact-${phone}`,
      tenantId: DEV_TENANT_ID,
      waId: phone,
      name,
      lastInboundAt,
    },
  });
}

async function findOrCreateConversation(
  contactId: string,
  phone: string,
  status: ConversationStatus,
  unreadCount: number,
  lastMessageAt: Date,
  lastPreview: string,
  assignedUserId: string | null
) {
  // Buscar conversación existente por contacto
  const existing = await prisma.conversation.findFirst({
    where: { tenantId: DEV_TENANT_ID, contactId },
  });
  if (existing) {
    return prisma.conversation.update({
      where: { id: existing.id },
      data: { status, unreadCount, lastMessageAt, lastPreview, assignedUserId },
    });
  }
  return prisma.conversation.create({
    data: {
      id: `${FIXTURE_PREFIX}conv-${phone}`,
      tenantId: DEV_TENANT_ID,
      contactId,
      phoneNumberId: null,
      status,
      unreadCount,
      lastMessageAt,
      lastInboundAt: lastMessageAt,
      lastPreview,
      assignedUserId,
    },
  });
}

async function findOrCreateMessage(
  conversationId: string,
  msgId: string,
  direction: MessageDirection,
  type: MessageType,
  status: MessageStatus,
  text: string,
  timestamp: Date,
  idempotencyKey: string
) {
  // Primero verificar si existe por idempotency key
  const existing = await prisma.message.findFirst({
    where: { tenantId: DEV_TENANT_ID, idempotencyKey },
  });
  if (existing) {
    return prisma.message.update({
      where: { id: existing.id },
      data: { direction, type, status, text, timestamp },
    });
  }
  // Si no existe, crear nuevo
  return prisma.message.create({
    data: {
      id: msgId,
      tenantId: DEV_TENANT_ID,
      conversationId,
      direction,
      type,
      status,
      text,
      timestamp,
      idempotencyKey,
    },
  });
}

async function main(forceRecreate: boolean = false) {
  console.log("=".repeat(60));
  console.log("Seed de fixtures para el Inbox de desarrollo");
  console.log("=".repeat(60));
  console.log();

  // Verificar tenant
  const tenant = await prisma.tenant.findUnique({
    where: { id: DEV_TENANT_ID },
  });

  if (!tenant) {
    console.error("❌ Tenant de desarrollo no encontrado");
    console.error("Ejecuta primero: WBA_ALLOW_DEMO_SEED=true npx tsx prisma/seed.ts");
    process.exit(1);
  }

  console.log(`✓ Tenant: ${tenant.name}`);

  if (forceRecreate) {
    console.log("⚠️  Modo FORCE: Eliminando fixtures...");
    await prisma.message.deleteMany({
      where: { tenantId: DEV_TENANT_ID, idempotencyKey: { startsWith: FIXTURE_PREFIX } },
    });
    await prisma.conversation.deleteMany({
      where: { tenantId: DEV_TENANT_ID, contactId: { startsWith: FIXTURE_PREFIX } },
    });
    await prisma.contact.deleteMany({
      where: { tenantId: DEV_TENANT_ID, waId: { in: FIXTURE_PHONES } },
    });
    console.log("✓ Fixtures eliminadas\n");
  } else {
    // Verificar existencia
    const existing = await prisma.conversation.count({
      where: { tenantId: DEV_TENANT_ID, contact: { waId: { in: FIXTURE_PHONES } } },
    });
    if (existing > 0) {
      console.log(`✓ ${existing} conversaciones fixture ya existen.`);
      console.log("   Ejecuta con --force para recrear.\n");
      const convs = await prisma.conversation.findMany({
        where: { tenantId: DEV_TENANT_ID, contact: { waId: { in: FIXTURE_PHONES } } },
        include: { contact: true, _count: { select: { messages: true } } },
        orderBy: { lastMessageAt: "desc" },
      });
      for (const c of convs) {
        console.log(`   - ${c.contact.name}: ${c._count.messages} msgs, ${c.status}`);
      }
      console.log("\nFIN: Seed idempotente completado.");
      return;
    }
  }

  console.log("Creando fixtures...\n");

  let convCount = 0;
  let msgCount = 0;

  for (const fixture of CONVERSATION_FIXTURES) {
    // Obtener usuario asignado
    let assignedUserId: string | null = null;
    if (fixture.assignedUserEmail) {
      const user = await prisma.user.findUnique({ where: { email: fixture.assignedUserEmail } });
      assignedUserId = user?.id ?? null;
    }

    const lastMsg = fixture.messages[fixture.messages.length - 1];
    const lastMessageAt = lastMsg ? calculateTimestamp(lastMsg.daysAgo, lastMsg.hoursOffset) : new Date();

    // Crear contacto
    const contact = await findOrCreateContact(
      fixture.phone,
      fixture.contactName,
      lastMessageAt
    );

    // Crear conversación
    const conversation = await findOrCreateConversation(
      contact.id,
      fixture.phone,
      fixture.status,
      fixture.unreadCount,
      lastMessageAt,
      lastMsg?.text?.substring(0, 100) ?? "",
      assignedUserId
    );

    // Crear mensajes
    for (let i = 0; i < fixture.messages.length; i++) {
      const msg = fixture.messages[i];
      const timestamp = calculateTimestamp(msg.daysAgo, msg.hoursOffset);
      const idempotencyKey = `${FIXTURE_PREFIX}msg-${fixture.phone}-${i.toString().padStart(3, "0")}`;
      const msgId = `${FIXTURE_PREFIX}msg-${fixture.phone}-${i.toString().padStart(3, "0")}`;

      await findOrCreateMessage(
        conversation.id,
        msgId,
        msg.direction,
        msg.type,
        msg.status,
        msg.text,
        timestamp,
        idempotencyKey
      );
      msgCount++;
    }

    convCount++;
    console.log(`  ✓ ${fixture.contactName}: ${fixture.messages.length} msgs, ${fixture.status}`);
  }

  console.log();
  console.log("=".repeat(60));
  console.log("RESUMEN");
  console.log("=".repeat(60));
  console.log(`Conversaciones: ${convCount}`);
  console.log(`Mensajes: ${msgCount}`);
  console.log();
  console.log("CREDENCIALES:");
  console.log("  Admin: admin@default.com / 123456");
  console.log("  Agente: agent@default.com / 123456");
  console.log("\nFIN: Seed completado.");
}

const args = process.argv.slice(2);
main(args.includes("--force"))
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
