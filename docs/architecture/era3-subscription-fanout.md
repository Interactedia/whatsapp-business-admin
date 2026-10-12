# WA-ERA3-07-FANOUT — Post-commit canonical subscription fanout

## Estado

Implementado como servicio de aplicación explícito e idempotente que convierte
eventos canónicos ya persistidos en `CanonicalEventOutbox` en registros de
entrega durables por destino suscrito. La activación automática de producción
sigue deshabilitada: WA-ERA3-07-FANOUT solo materializa entregas; no
despacha HTTP, no programa, no introduce nuevos daemon.

## Propósito

Antes de WA-ERA3-07-FANOUT el worker HTTP (`runCanonicalDeliveryWorker` en
`src/lib/events/delivery.ts`) requería un único destino preseleccionado por
el llamador. El orquestador tenía que saber, fuera de la plataforma, qué
destinos querían recibir cada tipo de evento.

WA-ERA3-07-FANOUT introduce la operación que faltaba:

1. Cargar un evento canónico ya comprometido.
2. Descubrir los destinos elegibles del mismo tenant suscritos al tipo de
   evento.
3. Crear un registro durable de entrega por cada destino elegible.
4. Devolver un resultado estructurado por destino, sin tocar la red.

## Arquitectura

```
                   committed canonical event
                              │
                              ▼
            getCanonicalEvent(db, tenantId, eventId)
                              │
                              ▼
        listEligibleWebhookDestinations(db, tenantId, eventType)
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        Destination A     Destination B     Destination C
              │               │               │
              ▼               ▼               ▼
        ensureDeliveryRecord  …           ensureDeliveryRecord
              │               │               │
              ▼               ▼               ▼
        Durable Delivery A  Durable Delivery B  Durable Delivery C
```

El fanout es un servicio de aplicación explícito:

- `src/lib/events/fanout.ts` — orquestación de fanout.
- `src/lib/events/webhook-destinations.ts` — `listEligibleWebhookDestinations`
  añadido a la superficie existente.
- `src/lib/events/delivery-state.ts` — reutiliza `ensureDeliveryRecord` para
  crear entregas con `ON CONFLICT DO UPDATE`.
- `src/lib/events/outbox.ts` — reutiliza `getCanonicalEvent` para cargar el
  evento del outbox.

No se introduce ninguna otra capa, cola, scheduler ni daemon.

## Contrato de entrada y salida

### `fanoutCanonicalEvent(db, { tenantId, eventId, now?, maxDestinations? })`

- `tenantId` (string, requerido): única fuente de verdad para ownership.
  El fanout nunca acepta URLs ni destinos aportados por el llamador.
- `eventId` (string, requerido): id del evento en `CanonicalEventOutbox`.
- `now` (Date, opcional): determinismo en pruebas; se reenvía a
  `nextAttemptAt` en `ensureDeliveryRecord`.
- `maxDestinations` (number, opcional, tope `MAX_FANOUT_DESTINATIONS_PER_INVOCATION = 500`).

Devuelve `FanoutResult`:

```ts
{
  tenantId: string;
  eventId: string;
  eventType: ExternalEventType;
  discoveredDestinations: number;
  created: number;
  alreadyExists: number;
  failed: number;
  outcomes: FanoutDestinationOutcome[];
}
```

Cada `FanoutDestinationOutcome` lleva `status` (`created | already_exists | failed`),
el `destinationId`, el `deliveryId` cuando aplica, y un mensaje de error
explícito cuando `status === "failed"`.

### Errores explícitos (`FanoutError`)

- `EVENT_NOT_FOUND` — el evento no existe para ese tenant.
- `TENANT_MISMATCH` — el evento existe pero pertenece a otro tenant.
- `UNSUPPORTED_EVENT_TYPE` — tipo de evento fuera de `EXTERNAL_EVENT_TYPES`.
- `INVALID_INPUT` — `tenantId` o `eventId` vacíos o ausentes.

Estos errores no crean entregas y son los únicos caminos en los que el fanout
lanza una excepción. Los fallos por destino individual se devuelven como
`outcomes[].status === "failed"` para preservar las entregas exitosas.

## Ownership de tenant

- El fanout requiere `tenantId` explícito; nunca infiere el tenant.
- `getCanonicalEvent(db, tenantId, eventId)` aplica `WHERE id = ? AND tenantId = ?`
  en la base. Un evento de tenant A cargado con `tenantId` de tenant B
  devuelve `null` y el fanout responde `EVENT_NOT_FOUND`.
- `listEligibleWebhookDestinations` filtra por `tenantId`; un destino del
  tenant B nunca aparece para un evento del tenant A aunque comparta tipo.
- La comparación final `destination.tenantId === event.tenantId` se realiza
  tras la lectura para defensa en profundidad.

## Coincidencia de suscripciones

- Sólo se usan los valores declarados en `EXTERNAL_EVENT_TYPES`
  (`inbound.message.received`, `outbound.message.accepted`,
  `outbound.message.status_changed`, `conversation.changed`).
- `WebhookDestination.subscriptions` es un `String[]`; la query usa
  Prisma `subscriptions: { has: eventType }`. No hay wildcards implícitos.
- Tipos desconocidos son rechazados por `isSupportedEventType` antes de
  tocar la base de datos.

## Límites transaccionales

El fanout no requiere una transacción externa. `ensureDeliveryRecord` ya
utiliza `INSERT … SELECT … FROM "CanonicalEventOutbox" WHERE id = ? AND tenantId = ?
ON CONFLICT (tenantId, eventId, destinationId) DO UPDATE SET "updatedAt" = "CanonicalEventDelivery"."updatedAt"`
como unidad atómica. Si el llamador quiere agrupar varias invocaciones, puede
envolver `fanoutCanonicalEvent` en `prisma.$transaction(async tx => …)` y
pasar el `tx` como `db`; la firma acepta tanto `typeof prisma` como
`Prisma.TransactionClient`.

## Creación de entregas

- Reutiliza `ensureDeliveryRecord` (WA-ERA3-05). No se duplica la lógica de
  estado de entrega.
- Uniqueness se impone en la base con `@@unique([tenantId, eventId, destinationId])`
  en `CanonicalEventDelivery`.
- El fanout no decide `maxAttempts`, `leaseOwner` ni `nextAttemptAt` por su
  cuenta: los valores por defecto de `ensureDeliveryRecord` se mantienen.

## Idempotencia

- Fanout repetido sobre el mismo `(tenantId, eventId)` no crea entregas
  duplicadas: la cláusula `ON CONFLICT` devuelve la fila existente.
- El helper `createOrFetchDelivery` distingue `created` vs `already_exists`
  comparando `createdAt` y `updatedAt` del registro devuelto. Si son
  idénticos, fue una inserción nueva; si `updatedAt > createdAt`, el registro
  ya existía.
- `FanoutResult.alreadyExists` se incrementa para que el llamador sepa
  cuántas entregas se recuperaron en vez de crearse.

## Concurrencia

- 8 invocaciones concurrentes de `fanoutCanonicalEvent` sobre el mismo
  evento producen exactamente 1 fila en `CanonicalEventDelivery` por destino.
- La garantía la aporta la base: la constraint `@@unique` rechaza la
  segunda inserción y la cláusula `ON CONFLICT` la convierte en no-op.
- El fanout no introduce cerrojos en memoria ni en aplicación. El motor
  PostgreSQL es la frontera de serialización.

## Aislamiento de fallos

- Si la creación de la entrega para un destino falla, el resultado se
  reporta como `outcomes[].status === "failed"` con `error`.
- Las entregas exitosas creadas en la misma invocación no se pierden.
- Reinvocar el fanout con el mismo evento vuelve a intentar únicamente
  las entregas que fallaron (las exitosas son idempotentes gracias a la
  constraint única).

## Reintentabilidad

- El fanout es seguro de reintentar. Los siguientes reintentos son
  idempotentes por construcción.
- No hay estado de aplicación que limpiar entre invocaciones.

## Comportamiento ante cambios de configuración del destino

- `enabled` y `retiredAt` se evalúan en tiempo de fanout. Un destino
  deshabilitado o retirado no genera nuevas entregas.
- Las entregas ya materializadas permanecen visibles y operables aunque el
  destino sea retirado o deshabilitado después. Esto preserva la auditoría
  histórica y la identidad estable de `destinationId`.
- `secretVersion`, `endpointUrl` y `subscriptions` del destino son los que
  estaban vigentes al momento de crear la entrega. Cambios posteriores no
  reescriben entregas existentes; los workers de despacho consultan el
  destino actual en cada intento, por lo que el ciclo de firma se mantiene
  coherente con la rotación.
- Esta política es intencional y se documenta explícitamente para evitar
  solicitudes de "redirección silenciosa" tras cambios de configuración.

## Scheduler y despacho automático

- WA-ERA3-07-FANOUT **no** introduce:
  - cron, systemd timers o daemon de producción.
  - cola BullMQ, Redis Pub/Sub ni WebSocket.
  - reintentos por su cuenta (los reintentos los mantiene el worker HTTP).
  - despacho HTTP.
- La activación de producción queda explícitamente fuera del scope; sólo
  se invoca desde código determinista (pruebas, futuras rutas operativas).

## Limitaciones conocidas

- El fanout descubre destinos con un solo lote. Si un tenant tiene más de
  `MAX_FANOUT_DESTINATIONS_PER_INVOCATION` destinos elegibles para un mismo
  tipo de evento, hay que paginar invocando varias veces. La paginación se
  realiza por `id` ascendente; el campo `afterId` aún no se ha expuesto en
  la API pública.
- El fanout no reporta eventos "no elegibles" (subscribed pero disabled);
  sólo los destinos que efectivamente materializaron una entrega. La
  auditoría de cambios de configuración se mantiene en `WebhookDestination`.

## Estado de activación en producción

Desactivado. La superficie existe, está probada con PostgreSQL real y
cumple los gates del IMPLEMENTATION_PACKET, pero ningún lazo de producción la
invoca todavía. La activación se abordará en WA-ERA3-CERT.
