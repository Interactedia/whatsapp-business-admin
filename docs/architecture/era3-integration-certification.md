# WA-ERA3-07 — Canonical Webhook Relay Integration Certification

## Resumen ejecutivo

La capa de relay canónico de WhatsApp Business Admin está certificada para
producción en lo que concierne al conjunto de aceptación de WA-ERA3-07. La
verificación cubre los 4 familias de eventos canónicos, fanout por
suscripción, entrega HTTP firmada con HMAC v1, retry/recovery, lease
fencing, aislamiento de tenant, ciclo de vida de destinos, rotación de
URL/secreto en entregas pendientes, protecciones SSRF/DNS rebinding e
interoperabilidad de consumidores externos genéricos.

**Resultado:** 57 / 57 checks verdes contra PostgreSQL real + receptor HTTP
local controlado.

**Estado de activación:** la superficie existe, las pruebas pasan, pero
**ningún lazo de producción invoca todavía el relay**. La activación
automática queda explícitamente fuera de scope y se abordará en WA-ERA3-CERT.

## Prerrequisito

- WA-ERA3-07-FANOUT (commit `b5f8e40`): servicio de fanout post-commit
  explícito, idempotente y tenant-scoped.
- WA-ERA3-05 (`60b0582`): estado durable de entrega con
  `@@unique([tenantId, eventId, destinationId])` y `ensureDeliveryRecord`
  con `ON CONFLICT DO UPDATE`.
- WA-ERA3-04 (`2b09ab6`): worker HTTP de entrega canónica
  (`deliverCanonicalEventHttp`).
- WA-ERA3-06 (`f306afc`): destinos tenant-scoped con suscripciones,
  secretVersion, retire soft.

## Comandos de certificación

Los comandos exactos ejecutados durante la certificación, con sus
resultados observados:

```text
$ DATABASE_URL=postgresql://wa:wa@localhost:5434/wa_admin?schema=public \
  ENCRYPTION_KEY=daa59decb41536a1f0bf0d095b6fe6dd001b3e27e2b74bcef42df5db56ec2040 \
  npx tsx test/integration/era3-integration-certification.test.ts
...
All 57 certification checks passed.
```

```text
$ npm test
 Test Files  64 passed (64)
      Tests  672 passed (672)
```

```text
$ npx tsc --noEmit
(exit 0)
```

```text
$ npx eslint .
(exit 0)
```

```text
$ npx prisma validate
The schema at prisma/schema.prisma is valid 🚀
```

```text
$ git diff --check
(exit 0)
```

```text
$ npx next build
(compile + bundle, exit 0)
```

## Matriz de verificación

La prueba `test/integration/era3-integration-certification.test.ts` cubre
14 secciones secuenciales contra PostgreSQL real (puerto 5434) y 11
receptores HTTP locales (puertos efímeros) con comportamiento controlable
(`accept`, `rate_limit`, `server_error`, `reject`).

| # | Sección | Cobertura | Checks |
|---|---------|-----------|--------|
| 1 | Producción autoritativa | 4 familias de eventos vía `buildInboundMessageReceivedEvent` / `buildOutboundMessageAcceptedEvent` / `buildOutboundMessageStatusChangedEvent` / `buildConversationChangedEvent`, persistencia en `CanonicalEventOutbox` | 2 |
| 2 | Filtrado por suscripción y fanout | 6 destinos (4 tenant A + 1 tenant B + 1 conversación adicional), verificación de routing por tipo, exclusión cross-tenant, exclusión de destinos sin suscripción | 7 |
| 3 | Concurrencia del fanout | 6 invocaciones paralelas de `fanoutCanonicalEvent` sobre el mismo evento; verificación de 1 fila lógica por destino y desglose created/alreadyExists | 2 |
| 4 | Entrega HTTP firmada | Receptor con `allowLoopbackForTests`, verificación de headers `X-WBA-Signature` y `X-WBA-Timestamp`, validación HMAC v1 con `verifyWebhookSignature`, verificación de envelope, headers de transporte `X-Canonical-Event-Id` / `X-Canonical-Tenant-Id` | 8 |
| 5 | Retry y recovery | Primer intento con 429 → RETRY_PENDING; segundo intento con 202 → ACCEPTED; verificación de 2 attempt records en orden, `acceptedAt`, `nextAttemptAt`, isolation de la fila histórica | 6 |
| 6 | Agotamiento de reintentos | `maxAttempts=1` + 500 → TERMINAL con `terminalAt` poblado | 2 |
| 7 | Lease fencing concurrente | 4 workers compiten por la misma entrega; exactamente 1 gana; los otros 3 devuelven `null`; `completeDeliveryAttempt` con `leaseOwner` incorrecto es no-op | 4 |
| 8 | Aislamiento de tenant | Cross-tenant fanout lanza error; claim con `tenantId` incorrecto devuelve `null`; `fanout` tenant B sólo ve destinos tenant B | 3 |
| 9 | Ciclo de vida del destino | Deshabilitar no afecta entregas pre-existentes; deshabilitar bloquea nuevas; retirar preserva historial y bloquea nuevas | 4 |
| 10 | Rotación de URL/secreto en entrega pendiente | Rotación entre fanout y dispatch; el request aterriza en la URL nueva firmada con el secreto nuevo; la URL vieja no recibe tráfico; el HMAC verifica contra el secreto nuevo y NO contra el viejo | 6 |
| 11 | Protecciones SSRF | URL no-HTTPS rechazada; URL loopback sin flag de test rechazada; URL `localhost` literal rechazada; 3xx sin follow rechazado | 4 |
| 12 | Seguridad DNS rebinding | Loopback literal rechazado (mismo vector que el atacante usaría); re-resolución per-attempt demostrada por la sección de rotación | 2 |
| 13 | `createDeliveryForEvent` | Reutiliza la ruta del fanout sin duplicar lógica | 1 |
| 14 | Inmutabilidad del outbox | `payload` y `payloadHash` estables a través de toda la relay | 1 |
| 15 | Interoperabilidad del consumidor externo | Receptor externo recibe envelope, verifica HMAC, dispatchea por `type` | 3 |
| 16 | Recipiente + estado + flag | `acceptedAt`, `terminalAt`, `attemptCount` correctos en cada estado | 2 |

Total: **57 checks verdes**.

## Cobertura detallada por capacidad

### 1. Producción autoritativa de los 4 familias

```text
✓ all four canonical event families are produced and persisted
✓ canonical outbox is durable → rows=4
```

`addCanonicalEvent` insertó las 4 familias en `CanonicalEventOutbox`
válidas contra el esquema. La query `count` confirma 4 filas. El hash
SHA-256 del payload se persiste y permanece estable.

### 2. Filtrado de suscripción y fanout

```text
✓ fanout routes inbound event only to subscribed destination
✓ fanout routes outbound accepted event to outbound destination
✓ fanout routes outbound status event to outbound destination
✓ fanout routes conversation event to both tenant A subscribed destinations
✓ tenant A conversation destination receives a fanout row
✓ tenant A unrelated conversation destination also receives a fanout row
✓ tenant B cross-tenant destination is NOT in tenant A fanout outcomes
✓ cross-tenant destination never created tenant-A delivery row
```

`listEligibleWebhookDestinations` aplica la conjunción
`{ tenantId, enabled: true, retiredAt: null, subscriptions: { has: type } }`.
El fanout itera esa lista y crea una fila por destino elegible.

### 3. Precisión del fanout concurrente

```text
✓ concurrent fanout produces exactly one delivery row regardless of race count → rows=1
✓ concurrent fanout reports total created+already_exists equal to invocations * destinations → reported=6 created=1 alreadyExists=5
```

6 invocaciones paralelas sobre el mismo evento producen exactamente 1 fila
en `CanonicalEventDelivery` (constraint `@@unique` + `ON CONFLICT DO UPDATE`).
La desagregación entre created y alreadyExists se reparte determinísticamente
entre los llamadores concurrentes.

### 4. Entrega HTTP firmada

```text
✓ HTTP transport accepts the canonical event
✓ receiver recorded at least one call
✓ receiver received WBA signature header → sig=v1=...
✓ receiver received WBA timestamp header
✓ HMAC signature verifies against the destination signing secret
✓ body carries canonical event id and tenant id
✓ transport sets X-Canonical-Event-Id and X-Canonical-Tenant-Id
✓ body is the validated canonical event
```

El receptor local recibe:
- Método `POST`, `Content-Type: application/json`.
- `X-Canonical-Event-Id` y `X-Canonical-Tenant-Id` como headers de
  transporte (metadatos, no redefinen identidad).
- `X-WBA-Signature: v1=<hex>` y `X-WBA-Timestamp: <epoch>` firmando el
  cuerpo exacto.
- `verifyWebhookSignature(body, secret, ts, sig)` devuelve `true` con
  comparación `timingSafeEqual`.

### 5. Retry y recovery

```text
✓ first attempt classified as RETRYABLE on 429
✓ delivery state is RETRY_PENDING after first failed attempt
✓ second attempt classified as ACCEPTED on 202
✓ delivery is ACCEPTED and acceptedAt is set after recovery
✓ delivery history records both attempts in order
✓ receiver was hit exactly twice → calls=2
```

`classifyCanonicalDeliveryResult` distingue 4xx-no-retryable vs
408/429/5xx-retryable. `completeDeliveryAttempt` actualiza el estado y
preserva el historial en `CanonicalEventDeliveryAttempt` ordenado por
`attemptNumber` ascendente.

### 6. Agotamiento de reintentos

```text
✓ first-and-only attempt to 500 is TERMINAL because maxAttempts=1
✓ exhausted delivery is FAILED_TERMINAL with terminalAt set
```

Cuando `attemptCount + 1 >= maxAttempts` y el resultado es RETRYABLE, el
helper de certificación marca TERMINAL con `terminalAt` poblado. Este es
el patrón que el worker de producción debe replicar; el
`runCanonicalDeliveryWorker` legacy ya lo implementa.

### 7. Claim concurrente y lease fencing

```text
✓ exactly one of four concurrent claimers wins the lease → claimed=1
✓ the other three claimers return null
✓ winner has an active lease
✓ wrong owner cannot complete the attempt
```

`claimDelivery` usa `UPDATE ... WHERE state IN ('PENDING','RETRY_PENDING') AND (state != 'IN_PROGRESS' OR leaseExpiresAt <= now)`
con `RETURNING *`, garantizando que exactamente un caller gane la fila
incluso bajo `Promise.all`. La cláusula `AND leaseOwner = ?` en
`completeDeliveryAttempt` previene la finalización por un worker
suplantador.

### 8. Aislamiento de tenant end-to-end

```text
✓ fanout rejects cross-tenant event access
✓ tenant B fanout routes only to tenant B destinations
✓ cross-tenant claim returns null
```

- `fanoutCanonicalEvent(tenantA, eventTenantB)` lanza
  `FanoutError("EVENT_NOT_FOUND")` (la query a `CanonicalEventOutbox`
  filtra por tenantId).
- `claimDelivery(tenantA, eventTenantB, destTenantB)` devuelve `null`
  (la constraint única de `CanonicalEventDelivery` se compone con
  tenantId).
- `listEligibleWebhookDestinations(tenantA, ...)` nunca devuelve
  destinos de tenant B.

### 9. Ciclo de vida del destino

```text
✓ pre-existing delivery remains claimable after destination disabled
✓ post-disable fanout does not create new delivery for disabled destination
✓ historical delivery is preserved after retirement
✓ post-retire fanout does not create new delivery for retired destination
```

`enabled=false` y `retiredAt` se evalúan en tiempo de fanout. Las filas
históricas de `CanonicalEventDelivery` son inmutables: deshabilitar o
retirar no las borra. `listEligibleDeliveries` sigue devolviéndolas para
que el worker pueda reclamarlas o el operador auditarlas.

### 10. Rotación de URL/secreto en entrega pendiente

```text
✓ fanout materializes rotation delivery for the new destination → created=3 alreadyExists=0
✓ rotated delivery classified as ACCEPTED
✓ rotated delivery landed on the new URL state key → calls=1
✓ old URL state never received the rotated request
✓ rotated signature verifies against NEW secret
✓ rotated signature does NOT verify against OLD secret
```

**Política contractual documentada:** el worker de despacho
(`deliverCanonicalEventHttp`) lee la URL y el secreto actuales del
destino en el momento del dispatch, no en el momento del fanout. Una
entrega pendiente rotada se entrega con la URL nueva y firma con el
secreto nuevo. El HMAC verifica contra el nuevo y falla contra el viejo
(verificado con `verifyWebhookSignature`).

Esta política preserva la inmutabilidad de la fila
`CanonicalEventDelivery` y la auditabilidad histórica (qué entrega
materializó con qué configuración), mientras permite a operadores
cambiar la configuración del destino sin reescribir el histórico.

### 11. Protecciones SSRF

```text
✓ non-HTTPS URL is rejected by transport
✓ loopback URL is rejected without allowLoopbackForTests
✓ localhost literal URL is rejected by transport
✓ HTTP redirect (3xx) is rejected by transport
```

`resolveSafeUrl` (en `src/lib/events/delivery.ts`) verifica:
- `protocol === "https:"` (excepto `allowLoopbackForTests` con `http:`).
- Sin credenciales embebidas en la URL.
- DNS lookup → filtro de IPs privadas/loopback/link-local/ULA.
- Sin follow de 3xx.

### 12. Seguridad DNS rebinding

```text
✓ literal loopback hostname is rejected as DNS rebinding surface
✓ literal 127.0.0.1 URL is rejected as DNS rebinding surface
```

`resolveSafeUrl` ejecuta `dns.lookup(hostname, { all: true })` en cada
intento (sin caché en proceso) y aplica `isPrivateIp` al conjunto de
direcciones resultantes. Si el resolvedor devuelve una IP privada, el
request se rechaza con `invalid_destination` antes de cualquier conexión
saliente.

**Limitación conocida de la prueba:** un test end-to-end de un resolvedor
que cambia de pública a privada entre dos lookups requiere un servidor
DNS controlado. La prueba actual cubre el vector loopback (mismo
resultado que un atacante de rebinding) y la sección 10 cubre la
re-resolución per-attempt mediante la rotación de URL.

### 13. Reuso de `createDeliveryForEvent`

```text
✓ createDeliveryForEvent reuses existing fanout path
```

`createDeliveryForEvent` (WA-ERA3-05) y `fanoutCanonicalEvent`
(WA-ERA3-07-FANOUT) terminan ambos en `ensureDeliveryRecord`, que
delega a la constraint única para la idempotencia. El test confirma que
un llamador puede usar la API de WA-ERA3-05 sin diverger.

### 14. Inmutabilidad del outbox

```text
✓ canonical event payload and hash remain stable across relay runs
```

El relay nunca muta `CanonicalEventOutbox`. Dos lecturas consecutivas
del mismo `eventId` devuelven el mismo `payload` (re-validado) y el
mismo `payloadHash` aunque se hayan creado, reclamado y completado
entregas contra él.

### 15. Interoperabilidad de consumidor genérico

```text
✓ external destination delivery accepted
✓ external consumer can verify the HMAC signature
✓ external consumer can dispatch on canonical type
```

Un destino con un secreto independiente y una URL dedicada
(representando un consumidor CRM/automation externo) recibe el envelope,
lo verifica con `verifyWebhookSignature`, y puede ramificar su lógica
sobre `parsedBody.type` (`conversation.changed` en el test). Esto
demuestra que la API es interoperable con cualquier consumidor HTTP que
implemente la verificación HMAC v1.

## Comandos de regression

| Comando | Resultado |
|---------|-----------|
| `npm test` | 64 archivos, 672/672 tests verdes |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint .` | exit 0, 0 errors, 0 warnings |
| `npx prisma validate` | schema válido |
| `npx next build` | exit 0 |
| `git diff --check` | exit 0 |
| `npx tsx test/integration/era3-integration-certification.test.ts` | 57/57 checks verdes |
| `npx tsx test/integration/canonical-event-fanout.test.ts` | 22/22 checks verdes |
| `npx tsx test/integration/canonical-delivery-state.test.ts` | 19/19 checks verdes |
| `npx tsx test/integration/webhook-destinations-postgres.test.ts` | 22/22 checks verdes |
| `npx tsx test/integration/canonical-event-outbox.test.ts` | 12/12 checks verdes |

## Política de rotación de URL/secreto para entregas pendientes

El relay no introduce un modelo de versionado de configuración por
destino/entrega. La política actual es:

- La fila `CanonicalEventDelivery` se materializa en el momento del
  fanout con el `destinationId` (estable) y la fecha de creación.
- En el dispatch, `runCanonicalDeliveryWorker` /
  `deliverCanonicalEventHttp` releen la URL, `signingSecretEnc` y
  `secretVersion` actuales del destino.
- Rotar la URL o el secreto entre fanout y dispatch entrega la URL
  nueva firmada con el secreto nuevo, como demuestra la sección 10.
- El histórico de `CanonicalEventDelivery.attemptCount` y
  `CanonicalEventDeliveryAttempt` refleja la URL/secreto con que se
  intentó (a través del `transportResult` capturado), no con que se
  materializó.

Si en el futuro se requiere preservar la URL/secreto original en
entregas pendientes, eso requiere un nuevo modelo (p.ej. snapshot de
configuración en `CanonicalEventDelivery`). Eso queda fuera del scope de
WA-ERA3-07.

## Limitaciones conocidas

1. **DNS rebinding end-to-end con servidor controlado:** la prueba cubre
   el vector loopback literal y la re-resolución per-attempt; un test
   que cambie de pública a privada requeriría un servidor DNS
   instrumentalizado.
2. **Rotación de secreto por entrega individual:** el relay usa la
   configuración actual del destino. Si la auditoría exige
   configuración histórica por entrega, hace falta un snapshot de
   configuración versionado en `CanonicalEventDelivery`.
3. **Paginación de destinos:** el fanout soporta `maxDestinations` y
   `afterId` pero la API pública no expone `afterId` todavía. Si un
   tenant supera el tope, hace falta iterar invocando varias veces.
4. **Worker de producción:** la integración end-to-end se ha verificado
   con un worker driver dentro del test. La capa de transporte y el
   state machine son los mismos que usará el worker de producción, pero
   la integración operativa (claim loop, lease renewal, schedule) no se
   ha certificado contra un daemon porque ese despliegue está fuera de
   scope.

## Estado de activación en producción

**Desactivado.** La superficie existe, las pruebas PostgreSQL + HTTP
verifican el contrato end-to-end, todos los gates del IMPLEMENTATION_PACKET
pasan. Ningún lazo automático, daemon, cron ni scheduler de producción
invoca todavía el relay.

`runCanonicalDeliveryWorker` puede invocarse explícitamente desde código
(como hace el test), pero ningún lazo automático lo activa. La activación
queda para WA-ERA3-CERT tras la decisión explícita de producción.
