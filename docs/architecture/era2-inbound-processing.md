# ERA 2 — Durable inbound webhook processing

## Estado

Implementado detrás de `WHATSAPP_INBOUND_ASYNC_ENABLED`. El valor por defecto es desactivado: cualquier valor distinto de `true` conserva el flujo legacy.

## Contrato de autenticación (WA-ERA5-02)

La autenticación es **fail-closed** y ocurre antes de cualquier mutación de negocio.

Cada `POST /api/webhook` se autentica con HMAC-SHA256 sobre los **bytes crudos e inalterados** de la request, comparando contra el header `X-Hub-Signature-256` con `crypto.timingSafeEqual`. Implementación: `src/lib/whatsapp/inbound/auth.ts`.

Se rechaza y **no** se enruta, encola ni persiste dominio cuando:

| Condición | `reason` persistido |
| --- | --- |
| Header ausente | `SIGNATURE_MISSING` |
| Header con forma distinta de `sha256=<64 hex>` | `SIGNATURE_MALFORMED` |
| Firma no coincide con ningún secreto configurado | `SIGNATURE_INVALID` |
| Ningún App Secret configurado (global ni por tenant) | `APP_SECRET_UNCONFIGURED` |

Los secretos candidatos se resuelven sólo desde configuración confiable del servidor: el singleton `WabaSettings` primero y luego `WabaAccount.appSecret` por tenant. Nunca se consulta un identificador aportado por el request.

La autenticación está separada del enrutamiento WABA: autenticar prueba **origen**, enrutar prueba **propiedad**. `signatureValid=false` jamás se interpreta como permiso para continuar.

La request siempre se responde `200 { received: true }` una vez registrada, para que Meta no reintente indefinidamente una entrega rechazada.

> **Requisito operativo:** sin App Secret configurado, todo webhook entrante se rechaza. Es el comportamiento aprobado (fail-closed) y difiere del legado, que procesaba cuerpos sin verificar cuando no había secreto global.

## Flujo legacy

`POST /api/webhook` autentica el cuerpo crudo (contrato anterior), guarda `WebhookEvent`, ejecuta `processWebhook(payload)` en la misma request y luego marca `processedOk=true` si el procesamiento termina.

La verificación `GET /api/webhook` no cambia.

## Orden de validación dentro de `handleInboundMessage`

Ninguna mutación ocurre hasta que toda la validación pasa:

1. `metadata.phone_number_id` presente → resolución a `PhoneNumber`/`WabaAccount`/tenant confiables.
2. Identidad del remitente (`from`) no vacía.
3. `msg.id` contra el charset de provider ID permitido.
4. Timestamp parseable.
5. Descarga de medios (best-effort, nunca bloquea).
6. Chequeo de idempotencia por `waMessageId`.

La creación de `Contact` vive **dentro** de la misma transacción PostgreSQL que `Conversation`, `Message` y los eventos canónicos. Si cualquier paso falla, el rollback elimina también el contacto: un evento rechazado no deja registros de negocio huérfanos.

`publish()` de realtime se ejecuta sólo después del commit, de modo que un mensaje revertido nunca se anuncia como nuevo.

## Charset de provider message ID (`wamid`)

`^[A-Za-z0-9_.:+/=-]{1,191}$` — definido una sola vez en `src/lib/events/validation.ts` y expuesto como `isValidProviderId`.

Los `wamid` reales de Meta están codificados en base64 y contienen `+`, `/` y `=` (longitud observada en el baseline: 82 caracteres). El charset anterior los rechazaba.

El tope de 191 se mantiene: `Message.waMessageId` es una columna `TEXT` sin límite, así que 191 es un techo de aplicación compartido con los demás identificadores del envelope, no una restricción de almacenamiento.

## Idempotencia de entregas duplicadas

`Message.waMessageId` tiene índice único global. Una entrega duplicada se detecta en dos puntos:

- **Secuencial:** pre-chequeo `findUnique` antes de la transacción → devuelve `dup <wamid>`.
- **Concurrente:** si dos entregas pasan el pre-chequeo a la vez, el índice único produce `P2002`; se reconsulta el mensaje ganador y se devuelve `dup <wamid>` en lugar de reportar un fallo de procesamiento.

En ambos casos no se duplica `Message` ni `Conversation`, y `unreadCount` no se incrementa dos veces.

## Diagnósticos de fallo en `WebhookEvent.error`

`error` sigue siendo una única columna `TEXT` (sin migración de esquema). Se persiste un objeto JSON de forma fija y acotada:

```json
{"stage":"webhook.authentication","category":"AUTH_REJECTED","reason":"SIGNATURE_MALFORMED","field":"x-hub-signature-256","correlationId":"cmv67qoxd..."}
```

| Campo | Contenido |
| --- | --- |
| `stage` | `webhook.authentication`, `inbound.processing`, `status.processing` |
| `category` | `AUTH_REJECTED`, `TENANT_UNRESOLVED`, `VALIDATION`, `DUPLICATE`, `UPSTREAM`, `INTERNAL` |
| `reason` | Código estable (p. ej. `SIGNATURE_INVALID`, `INVALID_IDENTIFIER`) |
| `field` | Campo de validación u header evaluado, cuando aplica |
| `correlationId` | ID de la fila `WebhookEvent` |

Límites: 160 caracteres por campo, 1024 en total, texto aplanado a una línea. Implementación: `src/lib/whatsapp/inbound/diagnostics.ts`.

**Nunca** se persisten App Secrets, access tokens, material de firma ni contenido del cuerpo. Las cadenas con forma de credencial (`accessToken=`, `Bearer`, `sha256=`, …) se redactan a `[REDACTED]` en vez de descartar el diagnóstico completo, para conservar su utilidad. `field` registra el nombre del header evaluado, nunca su valor.

## Flujo async durable

Cuando `WHATSAPP_INBOUND_ASYNC_ENABLED=true` y el payload contiene sólo mensajes inbound de cliente:

1. La request se autentica y valida igual que el flujo legacy.
2. Se resuelve el `PhoneNumber` persistido desde `metadata.phone_number_id`.
3. En una única transacción PostgreSQL se inserta `WebhookEvent` y `OutboxEvent` con un `InboundWebhookJobPayload`.
4. Sólo después del commit se responde `{ received: true }`.
5. El dispatcher de outbox publica a BullMQ fuera de la transacción.
6. El worker inbound, iniciado explícitamente por `createInboundWebhookWorker()`, lee el `WebhookEvent`, revalida tenant/WABA/teléfono persistidos y llama la lógica existente `processWebhook`.

Redis/BullMQ no participa en la aceptación durable. Si Redis cae, el `OutboxEvent` queda en PostgreSQL para reintento por el dispatcher.

Una falla al persistir el recibo async **no** se captura: se propaga como 5xx para que Meta reintente la entrega. Registrarla aquí equivaldría a confirmar (y perder) un fallo transitorio.

## Eventos no migrados en esta iteración

Status webhooks, template status webhooks, Flow replies y payloads mixtos siguen el flujo legacy aunque el flag esté activo. Esto preserva la compatibilidad de ACK y evita partir un payload Meta con reglas nuevas no aprobadas.

Los tipos válidos no soportados por el modo async no se descartan: se procesan por el flujo legacy existente.

## Idempotencia y duplicados

La identidad canónica sigue siendo `Message.waMessageId` con restricción única. El worker tolera ejecuciones repetidas: `processWebhook` conserva la detección existente y no crea mensajes duplicados.

BullMQ `jobId` ayuda a coalescer cola, pero no es garantía exactly-once. La garantía real es persistente: PostgreSQL, `WebhookEvent`, `OutboxEvent` y `waMessageId`.

## Tenant y WABA

La recepción async no confía tenant desde el payload Meta. Resuelve tenant/WABA desde `PhoneNumber.metaPhoneNumberId` persistido. El worker vuelve a verificar que `phoneNumberId`, `wabaAccountId` y `tenantId` del job coincidan en base de datos antes de mutar mensajes.

## Fallos observables

- Fallo PostgreSQL durante recepción: no hay commit, por tanto no se responde aceptación durable exitosa.
- Fallo Redis/dispatcher: el `OutboxEvent` permanece `PENDING`/`RETRYABLE`/`TERMINAL` inspeccionable por la infraestructura de outbox.
- Fallo worker: `WebhookEvent.error` y `eventSummary` registran el error y BullMQ aplica reintentos acotados.

## Worker lifecycle

`createInboundWebhookWorker()` crea un worker sólo cuando el proceso llamador lo invoca. Ningún worker ni dispatcher se inicia por import de módulo o por Next.js.

## Pruebas de integración

Comandos:

```bash
DATABASE_URL=postgresql://... npx tsx test/integration/inbound-outbox.test.ts
DATABASE_URL=postgresql://... REDIS_URL=redis://127.0.0.1:6379 npx tsx test/integration/inbound-worker.test.ts
```

Estas pruebas usan datos aislados y no llaman la API real de Meta.

## Prerrequisitos de activación

- PostgreSQL migrado con `WebhookEvent` y `OutboxEvent` existentes.
- Redis 7 disponible para BullMQ.
- Dispatcher de outbox iniciado explícitamente.
- Worker inbound iniciado explícitamente.
- Monitoreo de `OutboxEvent` y errores de `WebhookEvent`.
- Validación operativa de payloads mixtos antes de ampliar el modo async a status/templates.

## Limitaciones conocidas

`WebhookEvent.processedOk=false` significa “aceptado durablemente pero aún no procesado” mientras el job está pendiente. El procesamiento exitoso lo cambia a `true`.
