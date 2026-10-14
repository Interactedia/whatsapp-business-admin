# WhatsApp Business Admin — Contrato de Integración con n8n

> **Versión del documento:** 1.0
> **Fecha:** 2026-10-14
> **Repositorio inspeccionado:** `whatsapp-business-admin` (commit actual)
> **Propósito:** Extraer el contrato REAL entre WhatsApp Business Admin y n8n basándose en el código activo.

---

## 1. Propósito y Límites del Contrato

WhatsApp Business Admin es el backoffice que controla el canal de WhatsApp Business Cloud API. **n8n debe integrarse con este backoffice, no directamente con Meta.**

El contrato define dos direcciones de comunicación:

1. **WBA → n8n (webhooks salientes):** WhatsApp Business Admin notifica eventos a n8n mediante HTTP POST hacia URLs configuradas por el tenant.
2. **n8n → WBA (APIs entrantes):** n8n envía mensajes y opera conversaciones mediante APIs autenticadas con API keys.

### Límites del contrato

- Meta Cloud API **no** es parte de este contrato. WBA es el intermediario.
- WBA controla las conversaciones: n8n no puede manipular el canal directamente.
- Los eventos se producen desde estado duradero en PostgreSQL; Meta es la fuente de verdad para entrega.

**Referencias:**
- `src/lib/events/contract.ts` — contrato de eventos canónicos
- `src/lib/whatsapp/webhook.ts` — procesamiento de webhooks entrantes de Meta

---

## 2. Diagrama del Flujo Real

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          WhatsApp Business Admin                             │
│                                                                             │
│  ┌──────────────┐    ┌─────────────────┐    ┌────────────────────────┐    │
│  │  Meta/WA     │    │  WBA            │    │  PostgreSQL           │    │
│  │  Cloud API   │───▶│  Inbound        │───▶│  Messages, Contacts,  │    │
│  │  Webhook     │    │  Webhook Handler│    │  Conversations,      │    │
│  └──────────────┘    │  (verify sig)   │    │  CanonicalEventOutbox │    │
│                      └─────────────────┘    └───────────┬────────────┘    │
│                                                          │                 │
│  ┌──────────────┐    ┌─────────────────┐    ┌─────────▼────────────┐    │
│  │  n8n         │◀───│  Webhook         │◀───│  Outbound Event       │    │
│  │  (destinat.) │    │  Delivery Worker │    │  Delivery             │    │
│  └──────────────┘    └─────────────────┘    └────────────────────────┘    │
│                                                                             │
│  ┌──────────────┐    ┌─────────────────┐    ┌────────────────────────┐    │
│  │  n8n         │───▶│  API v1         │───▶│  WhatsApp Send API     │    │
│  │  (cliente)   │    │  /messages      │    │  (via WBA)            │    │
│  └──────────────┘    └─────────────────┘    └────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Referencias:**
- `src/app/api/webhook/route.ts` — endpoint de recepción de webhooks de Meta
- `src/lib/events/delivery.ts` — entrega de eventos a destinos externos
- `src/app/api/v1/messages/route.ts` — API para enviar mensajes

---

## 3. Webhooks Salientes (WBA → n8n)

### 3.1 Eventos Disponibles

WBA puede despachar estos tipos de eventos canónicos a n8n:

| Tipo de Evento | Descripción | Payload clave |
|---|---|---|
| `inbound.message.received` | Mensaje entrante de WhatsApp | `conversationId`, `messageId`, `contactId`, `type`, `preview` |
| `outbound.message.accepted` | Mensaje saliente aceptado por Meta | `conversationId`, `messageId`, `contactId`, `type` |
| `outbound.message.status_changed` | Cambio de estado de mensaje saliente | `messageId`, `previousStatus`, `status` |
| `conversation.changed` | Conversación creada o cambiada | `conversationId`, `kind`, `status` |

**Referencias:**
- `src/lib/events/contract.ts` (líneas 25-30) — `EXTERNAL_EVENT_TYPES`
- `src/lib/events/producers/canonical.ts` — constructores de eventos

### 3.2 Configuración de Destinos

Los webhooks se configuran por tenant mediante la UI o las APIs REST.

**APIs de gestión de destinos:**

```
GET    /api/tenants/:tenantId/webhook-destinations
POST   /api/tenants/:tenantId/webhook-destinations
GET    /api/tenants/:tenantId/webhook-destinations/:destinationId
PUT    /api/tenants/:tenantId/webhook-destinations/:destinationId
DELETE /api/tenants/:tenantId/webhook-destinations/:destinationId
POST   /api/tenants/:tenantId/webhook-destinations/:destinationId/enable
POST   /api/tenants/:tenantId/webhook-destinations/:destinationId/disable
POST   /api/tenants/:tenantId/webhook-destinations/:destinationId/rotate-secret
POST   /api/tenants/:tenantId/webhook-destinations/:destinationId/test
GET    /api/tenants/:tenantId/webhook-destinations/:destinationId/history
```

**Autorización:** Requiere sesión de usuario con rol `ADMIN` o `SYSTEM_ADMIN`.

**Modelo de datos (Prisma):**

```prisma
model WebhookDestination {
  id              String    @id @default(cuid())
  tenantId       String
  name            String
  endpointUrl    String
  enabled        Boolean   @default(true)
  retiredAt      DateTime?
  subscriptions  String[]  // ["inbound.message.received", ...]
  signingSecretEnc String  // AES-256-GCM cifrado
  secretVersion   Int      @default(1)
  lastTestAt      DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
}
```

**Referencias:**
- `prisma/schema.prisma` — modelo `WebhookDestination`
- `src/lib/events/webhook-destinations.ts` — lógica CRUD
- `src/app/api/tenants/[tenantId]/webhook-destinations/route.ts` — API REST

### 3.3 Payload del Evento Canónico

El envelope de cada evento:

```typescript
interface ExternalEvent {
  id: string;                    // UUID estable, deduplication key
  type: ExternalEventType;        // ej: "inbound.message.received"
  version: 1;                     // EXTERNAL_EVENT_CONTRACT_VERSION
  tenantId: string;              // exactamente un tenant
  occurredAt: string;             // RFC 3339 UTC
  recordedAt: string;              // RFC 3339 UTC
  entities: ExternalEntityRef[];  // referencias canónicas
  meta: {
    producer: "whatsapp-business-admin";
    correlationId?: string;
  };
  payload: EventPayload;          // específico por tipo
}
```

### 3.4 Headers y Firma

El transporte HTTP incluye:

```
Content-Type: application/json
X-Canonical-Event-Id: <event.id>
X-Canonical-Tenant-Id: <tenantId>
X-WBA-Timestamp: <unix_epoch_seconds>
X-WBA-Signature: v1=<hmac_sha256_hex>
```

**Firma HMAC-SHA256:**

- Base: `${timestamp}.${body_json}`
- Algoritmo: HMAC-SHA256
- Comparación: timing-safe
- Tolerancia: 300 segundos

**Referencias:**
- `src/lib/events/webhook-signing.ts` — `signWebhookBody`, `verifyWebhookSignature`
- `src/lib/events/delivery.ts` (líneas 185-191) — headers de envío

### 3.5 Persistencia y Reintentos

**Persistencia de eventos:**

Los eventos se almacenan en `CanonicalEventOutbox`:

```prisma
model CanonicalEventOutbox {
  id              String   @id
  tenantId        String
  eventType       String
  contractVersion Int
  payload         Json
  payloadHash     String
  occurredAt      DateTime
  recordedAt      DateTime
  createdAt       DateTime @default(now())
}
```

**Reintentos:**

| Parámetro | Valor por defecto |
|---|---|
| `maxAttempts` | 5 |
| `baseDelayMs` | 1,000 ms |
| `maxDelayMs` | 60,000 ms |
| `timeoutMs` | 5,000 ms |

**Clasificación de resultados:**

- `accepted` (2xx): siguiente evento
- `timeout` / `network_error` / 5xx / 429 / 408: reintentar
- `invalid_destination` / 4xx (no 408/429): terminal

**Referencias:**
- `src/lib/events/outbox.ts` — persistencia de eventos
- `src/lib/events/retry-policy.ts` — política de reintentos
- `src/lib/events/delivery-state.ts` — estado de entregas

### 3.6 Idempotencia y Entrega

- **Event ID** es la clave de deduplicación (consumidores DEBEN deduplicar en `id`).
- El ID se genera como: `["evt", type, tenantId, ...parts].join(":")`
- Cada entrega produce un registro en `CanonicalEventDelivery` y `CanonicalEventDeliveryAttempt`.

---

## 4. APIs Entrantes (n8n → WBA)

### 4.1 Envío de Mensajes

**Endpoint principal:**

```
POST /api/v1/messages
```

**Autenticación:** API Key vía header `X-Api-Key` (o `Authorization: Bearer`, query `?apikey=`, o body `apikey`)

**Headers requeridos:**

```
X-Api-Key: wba_live_<key>
Content-Type: application/json
```

**Parámetros del body:**

| Campo | Tipo | Requerido | Descripción |
|---|---|---|---|
| `to` | string | Sí | Número destino (7-15 dígitos, sin +) |
| `type` | enum | No | `text`, `image`, `video`, `audio`, `document`, `template` |
| `text` | string | Sí* | Contenido del mensaje (* para tipo text) |
| `media` | object | Sí* | `{link?, id?, caption?, filename?}` (* para tipo media) |
| `template` | string | Sí* | Nombre de template (* para tipo template) |
| `language` | string | No | Código de idioma del template |
| `body_variables` | array/object | No | Variables del body |
| `header_text` | string | No | Texto del header |
| `header_media` | object | No | Media del header |
| `buttons` | array | No | Botones del template |

**Referencias:**
- `src/app/api/v1/messages/route.ts` (líneas 35-53) — esquema Zod
- `src/lib/v1.ts` — helpers de API v1
- `src/lib/api-keys.ts` — verificación de API keys

### 4.2 Endpoint de Conversaciones (Sesión de usuario)

```
GET    /api/tenants/:tenantId/conversations
POST   /api/tenants/:tenantId/conversations
GET    /api/tenants/:tenantId/conversations/:conversationId
GET    /api/tenants/:tenantId/conversations/:conversationId/messages
POST   /api/tenants/:tenantId/conversations/:conversationId/messages
POST   /api/tenants/:tenantId/conversations/:conversationId/typing
```

**Autenticación:** Sesión de usuario (NextAuth) + membresía activa en tenant.

**Referencias:**
- `src/app/api/tenants/[tenantId]/conversations/route.ts`
- `src/app/api/tenants/[tenantId]/conversations/[conversationId]/messages/route.ts`
- `src/app/api/tenants/[tenantId]/conversations/[conversationId]/typing/route.ts`

### 4.3 Gestión de Destinos Webhook

**Endpoints REST para administrar destinos de webhook (n8n como consumidor):**

```
GET    /api/tenants/:tenantId/webhook-destinations
POST   /api/tenants/:tenantId/webhook-destinations
GET    /api/tenants/:tenantId/webhook-destinations/:destinationId
PUT    /api/tenants/:tenantId/webhook-destinations/:destinationId
DELETE /api/tenants/:tenantId/webhook-destinations/:destinationId
POST   /api/tenants/:tenantId/webhook-destinations/:destinationId/test
```

**Autenticación:** Sesión de usuario (rol ADMIN).

**Referencias:**
- `src/app/api/tenants/[tenantId]/webhook-destinations/route.ts`

### 4.4 Autorización por Tenant

WBA es **multi-tenant**. Cada API key pertenece a exactamente un tenant.

```typescript
type ApiKeyPrincipal = {
  apiKeyId: string;
  userId: string | null;   // null para API keys
  tenantId: string | null; // null = key no asignada a tenant
};
```

La autorización verifica:
1. API key existe y no está revocada.
2. API key tiene `tenantId` asignado.
3. El tenant tiene números de teléfono configurados.

**Referencias:**
- `src/lib/api-keys.ts` (líneas 31-48) — `verifyApiKey`
- `src/lib/tenant/index.ts` (líneas 32-43) — `resolveApiKeyTenantContext`

---

## 5. Autenticación, Tenant y Seguridad

### 5.1 Inbound (Meta → WBA)

El webhook de Meta se autentica mediante HMAC-SHA256 con App Secret.

**Header:** `X-Hub-Signature-256: sha256=<hex>`

**Fail-closed:** Si la firma no coincide o falta App Secret, el evento se rechaza sin mutar estado.

**Referencias:**
- `src/lib/whatsapp/inbound/auth.ts` — `authenticateMetaWebhook`
- `src/app/api/webhook/route.ts` (líneas 54-94)

### 5.2 Outbound (WBA → n8n)

Los webhooks salientes se firman con un secreto configurable por destino.

**Headers:** `X-WBA-Timestamp` + `X-WBA-Signature: v1=<hmac>`

**Referencias:**
- `src/lib/events/webhook-signing.ts`

### 5.3 APIs (n8n → WBA)

- **v1 API (`/api/v1/*`)**: API Key obligatoria.
- **Tenant APIs (`/api/tenants/:tenantId/*`)**: Sesión de usuario + membresía.

### 5.4 SSRF Protection

El delivery de webhooks valida:
- Solo HTTPS en producción (HTTP permitido en tests).
- No sigue redirects.
- Rechaza IPs privadas/reservadas.
- Timeout acotado (5-30 segundos).

**Referencias:**
- `src/lib/events/delivery.ts` (líneas 107-126) — `resolveSafeUrl`

---

## 6. Idempotencia, Reintentos, Timeouts y Errores

### 6.1 Idempotencia (APIs de envío)

```http
POST /api/v1/messages
Idempotency-Key: <client-generated-uuid>
```

**Comportamiento:**
- Primera solicitud: 201 (sync) o 202 (async) según feature flag.
- Duplicado equivalente: 200 con `{id, to, duplicate: true, ...}`
- Misma key, payload diferente: 409 `IDEMPOTENCY_KEY_CONFLICT`

**Clave única:** `tenantId + idempotencyKey`

**Referencias:**
- `src/lib/idempotency.ts` — `parseIdempotencyKey`, `runIdempotent`
- `src/app/api/v1/messages/route.ts` (líneas 77-346)

### 6.2 Ventana de 24 Horas

Los mensajes de texto/media requieren que el contacto haya enviado un mensaje en las últimas 24 horas.

```
403: "Recipient is outside the 24-hour window; free-form messages are not allowed."
```

Templates no tienen esta restricción.

### 6.3 Errores Comunes

| Código | Significado |
|---|---|
| 400 | Body malformado, JSON inválido, campos requeridos faltantes |
| 401 | API key inválida o faltante |
| 403 | Sin permisos, fuera de ventana de 24h, sin teléfono autorizado |
| 404 | Recurso no encontrado (template, conversación) |
| 409 | Conflicto de idempotencia |
| 500 | Error interno |

### 6.4 Timeouts

| Operación | Timeout |
|---|---|
| Delivery de webhook | 5,000 ms (default), max 30,000 ms |
| Envío de mensaje (sync) | Configuración del servidor |

---

## 7. Ejemplos Sintéticos

### 7.1 Evento `inbound.message.received`

```json
{
  "id": "evt:inbound.message.received:tenant_abc123:msg_xyz789",
  "type": "inbound.message.received",
  "version": 1,
  "tenantId": "tenant_abc123",
  "occurredAt": "2026-10-14T12:30:00.000Z",
  "recordedAt": "2026-10-14T12:30:00.500Z",
  "entities": [
    { "kind": "tenant", "id": "tenant_abc123" },
    { "kind": "waba", "id": "waba_456" },
    { "kind": "phone", "id": "phone_789" },
    { "kind": "conversation", "id": "conv_111" },
    { "kind": "message", "id": "msg_xyz789", "providerId": "wamid.xxx" },
    { "kind": "contact", "id": "contact_222" }
  ],
  "meta": {
    "producer": "whatsapp-business-admin"
  },
  "payload": {
    "conversationId": "conv_111",
    "messageId": "msg_xyz789",
    "contactId": "contact_222",
    "phoneNumberId": "phone_789",
    "wabaAccountId": "waba_456",
    "type": "TEXT",
    "receivedAt": "2026-10-14T12:30:00.000Z",
    "providerMessageId": "wamid.xxx",
    "preview": "Hola, necesito información sobre..."
  }
}
```

### 7.2 Evento `outbound.message.status_changed`

```json
{
  "id": "evt:outbound.message.status_changed:tenant_abc123:msg_out_001:SENT",
  "type": "outbound.message.status_changed",
  "version": 1,
  "tenantId": "tenant_abc123",
  "occurredAt": "2026-10-14T12:31:00.000Z",
  "recordedAt": "2026-10-14T12:31:00.300Z",
  "entities": [
    { "kind": "tenant", "id": "tenant_abc123" },
    { "kind": "waba", "id": "waba_456" },
    { "kind": "phone", "id": "phone_789" },
    { "kind": "conversation", "id": "conv_111" },
    { "kind": "message", "id": "msg_out_001" }
  ],
  "meta": { "producer": "whatsapp-business-admin" },
  "payload": {
    "conversationId": "conv_111",
    "messageId": "msg_out_001",
    "phoneNumberId": "phone_789",
    "wabaAccountId": "waba_456",
    "previousStatus": "PENDING",
    "status": "SENT",
    "changedAt": "2026-10-14T12:31:00.000Z",
    "providerMessageId": "wamid.yyy"
  }
}
```

### 7.3 Solicitud `POST /api/v1/messages`

```http
POST /api/v1/messages HTTP/1.1
Host: your-wba-instance.com
X-Api-Key: wba_live_abc123...
Content-Type: application/json
Idempotency-Key: client-unique-key-001

{
  "to": "5491100011122",
  "type": "text",
  "text": "Gracias por su mensaje. Un agente le responderá pronto."
}
```

**Respuesta exitosa (201):**

```json
{
  "status": "success",
  "message_id": "wamid.outbound_123",
  "id": "msg_out_001",
  "to": "5491100011122"
}
```

**Respuesta asíncrona (202):**

```json
{
  "status": "success",
  "id": "msg_out_001",
  "status": "PENDING",
  "to": "5491100011122",
  "accepted": true
}
```

### 7.4 Solicitud de Template

```http
POST /api/v1/messages HTTP/1.1
X-Api-Key: wba_live_abc123...
Content-Type: application/json

{
  "to": "5491100011122",
  "type": "template",
  "template": "order_confirmation",
  "language": "es_AR",
  "body_variables": {
    "order_id": "#A12345",
    "customer_name": "Juan"
  }
}
```

---

## 8. Tabla de Funcionalidades

### 8.1 Webhooks Salientes (WBA → n8n)

| Funcionalidad | Estado | Referencias |
|---|---|---|
| Modelo `WebhookDestination` en Prisma | **IMPLEMENTADO** | `prisma/schema.prisma` |
| CRUD de destinos via API REST | **IMPLEMENTADO** | `src/lib/events/webhook-destinations.ts` |
| Suscripciones por tipo de evento | **IMPLEMENTADO** | `src/lib/events/webhook-destinations.ts` (líneas 13-14) |
| Firma HMAC-SHA256 de eventos | **IMPLEMENTADO** | `src/lib/events/webhook-signing.ts` |
| Delivery HTTP con timeout | **IMPLEMENTADO** | `src/lib/events/delivery.ts` |
| Reintentos configurables | **IMPLEMENTADO** | `src/lib/events/retry-policy.ts` |
| Historial de entregas | **IMPLEMENTADO** | `src/lib/events/webhook-destinations.ts` (líneas 346-366) |
| Prueba sintética de destino | **IMPLEMENTADO** | `src/lib/events/webhook-destinations.ts` (líneas 319-335) |
| Rotación de secretos | **IMPLEMENTADO** | `src/lib/events/webhook-destinations.ts` (líneas 239-256) |
| SSRF protection | **IMPLEMENTADO** | `src/lib/events/delivery.ts` (líneas 107-126) |
| UI de gestión de webhooks | **IMPLEMENTADO** | `src/app/(app)/t/[tenantId]/settings/webhooks/` |
| Fanout automático a destinos | **PENDIENTE** | No conectado a outbox explícito en código |
| Cola durable (BullMQ) | **PROPUESTO (ADR-0005)** | No implementado aún |

### 8.2 APIs Entrantes (n8n → WBA)

| Funcionalidad | Estado | Referencias |
|---|---|---|
| `POST /api/v1/messages` (texto) | **IMPLEMENTADO** | `src/app/api/v1/messages/route.ts` |
| `POST /api/v1/messages` (media) | **IMPLEMENTADO** | `src/app/api/v1/messages/route.ts` (líneas 180-230) |
| `POST /api/v1/messages` (template) | **IMPLEMENTADO** | `src/app/api/v1/messages/route.ts` (líneas 232-334) |
| Verificación de API Key | **IMPLEMENTADO** | `src/lib/api-keys.ts` |
| Idempotencia con header | **IMPLEMENTADO** | `src/lib/idempotency.ts` |
| Ventana de 24 horas | **IMPLEMENTADO** | `src/lib/whatsapp/send.ts` |
| Crear conversación | **IMPLEMENTADO** | `src/app/api/tenants/[tenantId]/conversations/route.ts` |
| Listar conversaciones | **IMPLEMENTADO** | `src/app/api/tenants/[tenantId]/conversations/route.ts` |
| Enviar en conversación existente | **IMPLEMENTADO** | `src/app/api/tenants/[tenantId]/conversations/[conversationId]/messages/route.ts` |
| Indicador de escritura | **IMPLEMENTADO** | `src/app/api/tenants/[tenantId]/conversations/[conversationId]/typing/route.ts` |
| Flujos de WhatsApp | **IMPLEMENTADO** | `src/app/api/flows/` |
| Outbound async (BullMQ) | **IMPLEMENTADO (flag)** | `WHATSAPP_OUTBOUND_ASYNC_ENABLED` |

### 8.3 Funcionalidades No Disponibles / PENDIENTE

| Funcionalidad | Estado | Notas |
|---|---|---|
| WebSocket realtime | **NO ENCONTRADO** | No hay servidor WS activo en el código |
| Cola durable (outbound) | **FLAG only** | `WHATSAPP_OUTBOUND_ASYNC_ENABLED` habilita cola |
| Cola durable (inbound) | **FLAG only** | `WHATSAPP_INBOUND_ASYNC_ENABLED` |
| Cola durable (status) | **FLAG only** | `WHATSAPP_STATUS_ASYNC_ENABLED` |
| API REST para contactos | **DOCUMENTADO/PENDIENTE** | `src/app/api/contacts/route.ts` existe pero no verificado activo |
| API REST para templates | **PARCIAL** | `src/app/api/templates/` existe, sync parcial |
| n8n workflow predefinido | **NO ENCONTRADO** | Ningún workflow de n8n en el repo |

### 8.4 LEGACY / TEST

| Funcionalidad | Estado | Notas |
|---|---|---|
| Envío sync (sin cola) | **LEGACY** | Default cuando `WHATSAPP_OUTBOUND_ASYNC_ENABLED=false` |
| Procesamiento inline de webhooks | **LEGACY** | Cuando flags async están off |

---

## 9. Información para Configurar en n8n

### 9.1 Configurar Destino Webhook en WBA

1. Ir a: **Configuración → Integraciones → Webhooks salientes**
2. Crear nuevo destino:
   - **Nombre:** `n8n Workflow Trigger`
   - **URL del endpoint:** `https://your-n8n-instance.com/webhook/whatsapp-events`
   - **Eventos suscritos:** Seleccionar según necesidad
     - `inbound.message.received` — mensajes entrantes
     - `outbound.message.accepted` — mensajes aceptados
     - `outbound.message.status_changed` — cambios de estado
     - `conversation.changed` — cambios de conversación
3. **Copiar el signing secret** — se muestra solo una vez.
4. Habilitar el destino.

### 9.2 Configurar n8n como Cliente API

1. En WBA, crear API Key:
   - Ir a **Configuración → API Keys**
   - Nombre: `n8n Integration`
   - Copiar la clave (formato: `wba_live_...`)
2. En n8n, usar nodo **HTTP Request** con:
   - Method: `POST`
   - URL: `https://your-wba-instance.com/api/v1/messages`
   - Headers:
     - `X-Api-Key: wba_live_...`
     - `Content-Type: application/json`
   - Body: según tipo de mensaje

### 9.3 Preguntas Abiertas

| Pregunta | Estado | Decisión requerida |
|---|---|---|
| ¿El fanout automático a destinos está conectado? | **NO CONFIRMADO** | Verificar que el outbox produce eventos hacia destinos activos |
| ¿La cola BullMQ está activa por defecto? | **FLAG ONLY** | Configurar variables de entorno para habilitar |
| ¿Redis es requerido? | **PROPUESTO (ADR-0005)** | ADR-0005 aún no implementado |
| ¿Límites de rate limit por tenant? | **NO ENCONTRADO** | No hay límite documentado en el código |
| ¿Sesiones de conversación tienen timeout? | **NO ENCONTRADO** | No hay evidencia de cleanup de sesiones |

---

## 10. Referencias a Archivos y Símbolos Inspectados

### Contrato de Eventos

| Archivo | Símbolos | Propósito |
|---|---|---|
| `src/lib/events/contract.ts` | `EXTERNAL_EVENT_TYPES`, `ExternalEvent`, `ExternalEventPayload` | Definición del contrato v1 |
| `src/lib/events/producers/canonical.ts` | `buildInboundMessageReceivedEvent`, `buildOutboundMessageStatusChangedEvent`, etc. | Constructores de eventos |
| `src/lib/events/validation.ts` | `validateExternalEvent`, `ExternalEventValidationError` | Validación de eventos |

### Webhooks Salientes

| Archivo | Símbolos | Propósito |
|---|---|---|
| `src/lib/events/webhook-destinations.ts` | `createWebhookDestination`, `listWebhookDestinations`, `deliverToDestination` | CRUD y dispatch |
| `src/lib/events/delivery.ts` | `deliverCanonicalEventHttp`, `runCanonicalDeliveryWorker` | Entrega HTTP |
| `src/lib/events/delivery-state.ts` | `claimDelivery`, `completeDeliveryAttempt` | Estado de entregas |
| `src/lib/events/webhook-signing.ts` | `signWebhookBody`, `verifyWebhookSignature` | Firma HMAC |
| `src/lib/events/retry-policy.ts` | `nextRetryDecision`, `DEFAULT_DELIVERY_MAX_ATTEMPTS` | Reintentos |

### APIs Entrantes

| Archivo | Símbolos | Propósito |
|---|---|---|
| `src/app/api/v1/messages/route.ts` | `POST` handler | Envío de mensajes |
| `src/app/api/tenants/[tenantId]/conversations/route.ts` | `GET`, `POST` | Conversaciones |
| `src/app/api/tenants/[tenantId]/conversations/[conversationId]/messages/route.ts` | `GET`, `POST` | Mensajes en conversación |
| `src/app/api/tenants/[tenantId]/conversations/[conversationId]/typing/route.ts` | `POST` | Indicador de escritura |
| `src/app/api/tenants/[tenantId]/webhook-destinations/route.ts` | `GET`, `POST` | Gestión de destinos |

### Autenticación y Autorización

| Archivo | Símbolos | Propósito |
|---|---|---|
| `src/lib/api-keys.ts` | `verifyApiKey`, `generateKey` | API keys v1 |
| `src/lib/tenant/index.ts` | `resolveApiKeyTenantContext`, `resolveTenantContext` | Resolución de contexto |
| `src/lib/v1.ts` | `requireApiKey`, `v1Handle`, `ApiError` | Helpers v1 |
| `src/lib/whatsapp/inbound/auth.ts` | `authenticateMetaWebhook`, `SIGNATURE_HEADER` | Auth de webhooks Meta |

### Persistencia

| Archivo | Símbolos | Propósito |
|---|---|---|
| `src/lib/events/outbox.ts` | `addCanonicalEvent`, `listCanonicalEvents` | Outbox de eventos |
| `src/lib/idempotency.ts` | `parseIdempotencyKey`, `runIdempotent` | Idempotencia |
| `prisma/schema.prisma` | `WebhookDestination`, `CanonicalEventOutbox`, `ApiKey`, `Message` | Modelos |

### Documentación Relacionada

| Archivo | Tema |
|---|---|
| `docs/architecture/era3-canonical-event-contract.md` | Contrato de eventos |
| `docs/architecture/era3-webhook-destinations.md` | Destinos webhook |
| `docs/architecture/era3-integration-certification.md` | Certificación de integración |
| `docs/adr/0005-durable-queues.md` | ADR de colas (propuesto) |
| `docs/adr/0006-webhook-relay.md` | ADR de relay webhook (propuesto) |

---

## Notas Finales

- **WBA es el intermediario entre Meta y n8n.** n8n nunca se comunica directamente con la WhatsApp Cloud API.
- **El contrato de eventos es v1.** Futuras versiones incrementarán `EXTERNAL_EVENT_CONTRACT_VERSION`.
- **La idempotencia es obligatoria** para `POST /api/v1/messages` cuando se usan reintentos.
- **Los secretos de webhook se muestran solo una vez** en creación o rotación.
- **SSRF protection está activa** en producción — no se pueden entregar eventos a IPs privadas.

---

*Este documento fue generado mediante inspección del código fuente activo del repositorio. El código ejecutable es la fuente de verdad; cualquier discrepancia entre este documento y el código debe resolverse a favor del código.*
