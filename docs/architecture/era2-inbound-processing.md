# ERA 2 — Durable inbound webhook processing

## Estado

Implementado detrás de `WHATSAPP_INBOUND_ASYNC_ENABLED`. El valor por defecto es desactivado: cualquier valor distinto de `true` conserva el flujo legacy.

## Flujo legacy

`POST /api/webhook` lee el cuerpo crudo, verifica la firma Meta con el secreto global o secretos de WABA persistidos, guarda `WebhookEvent`, ejecuta `processWebhook(payload)` en la misma request y luego marca `processedOk=true` si el procesamiento termina.

La verificación `GET /api/webhook` no cambia.

## Flujo async durable

Cuando `WHATSAPP_INBOUND_ASYNC_ENABLED=true` y el payload contiene sólo mensajes inbound de cliente:

1. La request se valida igual que el flujo legacy.
2. Se resuelve el `PhoneNumber` persistido desde `metadata.phone_number_id`.
3. En una única transacción PostgreSQL se inserta `WebhookEvent` y `OutboxEvent` con un `InboundWebhookJobPayload`.
4. Sólo después del commit se responde `{ received: true }`.
5. El dispatcher de outbox publica a BullMQ fuera de la transacción.
6. El worker inbound, iniciado explícitamente por `createInboundWebhookWorker()`, lee el `WebhookEvent`, revalida tenant/WABA/teléfono persistidos y llama la lógica existente `processWebhook`.

Redis/BullMQ no participa en la aceptación durable. Si Redis cae, el `OutboxEvent` queda en PostgreSQL para reintento por el dispatcher.

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
