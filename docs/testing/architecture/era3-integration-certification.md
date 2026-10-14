# WA-ERA3-07 — Canonical Webhook Relay Integration Certification

## Resumen ejecutivo

La capa de relay canónico de WhatsApp Business Admin está certificada para
producción en lo que concierne al conjunto de aceptación de WA-ERA3-07,
incluyendo la remediación de seguridad WA-ERA3-07-SECURITY-REMEDIATION. La
verificación cubre los 4 familias de eventos canónicos, fanout por
suscripción, entrega HTTP firmada con HMAC v1, retry/recovery, lease
fencing, aislamiento de tenant, ciclo de vida de destinos, suspensión atómica
de entregas ante cambios de endpoint, resolución administrativa con
confirmación explícita de destinatario, rotación de secreto aislada,
protecciones SSRF/DNS rebinding con fijación en tiempo de conexión e
interoperabilidad de consumidores externos genéricos.

**Resultado:** 88 / 88 checks verdes contra PostgreSQL real + receptor HTTP
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
All 88 certification checks passed.
```

```text
$ npm test
 Test Files  65 passed (65)
      Tests  695 passed (695)
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
✓ Compiled successfully
Error occurred prerendering page "/login"
TypeError: Cannot read properties of null (reading 'useState')
(exit 1 — preexistente, ver "Comandos de regression")
```

## Matriz de verificación

La prueba `test/integration/era3-integration-certification.test.ts` cubre
16 secciones secuenciales contra PostgreSQL real (puerto 5434) y 14
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
| 10 | Rotación de secreto en entrega pendiente | Rotación de secreto entre fanout y dispatch; el request aterriza en el endpoint configurado del destino firmado con el secreto nuevo; el HMAC verifica contra el secreto nuevo y NO contra el viejo; la rotación no suspende la entrega | 6 |
| 10b | Suspensión por cambio de endpoint (WA-ERA3-07-SECURITY-REMEDIATION) | El cambio de URL suspende atómicamente PENDING/RETRY_PENDING/IN_PROGRESS; las entregas suspendidas no son despachables; fencing de worker obsoleto; sin emisión HTTP; rollback transaccional; persistencia tras restart; resolución administrativa con confirmación explícita de destinatario; aislamiento cross-tenant; rotación de secreto no reanuda | 27 |
| 11 | Protecciones SSRF | URL no-HTTPS rechazada; URL loopback sin flag de test rechazada; URL `localhost` literal rechazada; 3xx sin follow rechazado | 4 |
| 12 | Seguridad DNS rebinding | Loopback literal rechazado; resolvedor que cambia de pública a privada tras la validación no redirige la conexión; DNS resuelto exactamente una vez por dispatch; conexión fijada a la dirección validada | 6 |
| 13 | `createDeliveryForEvent` | Reutiliza la ruta del fanout sin duplicar lógica | 1 |
| 14 | Inmutabilidad del outbox | `payload` y `payloadHash` estables a través de toda la relay | 1 |
| 15 | Interoperabilidad del consumidor externo | Receptor externo recibe envelope, verifica HMAC, dispatchea por `type` | 3 |
| 16 | Recipiente + estado + flag | `acceptedAt`, `terminalAt`, `attemptCount` correctos en cada estado | 2 |

Total: **88 checks verdes**.

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

### 10. Rotación de secreto en entrega pendiente

```text
✓ fanout materializes rotation delivery for the new destination → created=3 alreadyExists=0
✓ secret rotation keeps the pending delivery dispatchable
✓ delivery landed on its configured endpoint receiver → calls=1
✓ no request went to the unused rotation-v1 receiver
✓ rotated signature verifies against NEW secret
✓ rotated signature does NOT verify against OLD secret
```

**Política contractual documentada:** la rotación del *secreto* de firma no
mueve, suspende ni reanuda entregas. El worker de despacho
(`deliverCanonicalEventHttp`) firma con el secreto vigente al momento del
dispatch; una entrega pendiente firmada con el secreto nuevo verifica contra
el nuevo y falla contra el viejo (verificado con `verifyWebhookSignature`).
El cambio de *URL* se rige por la política de suspensión (sección 10b).

Esta política preserva la inmutabilidad de la fila
`CanonicalEventDelivery` y la auditabilidad histórica, mientras permite a
operadores rotar credenciales sin reescribir el histórico.

### 10b. Suspensión por cambio de endpoint (WA-ERA3-07-SECURITY-REMEDIATION)

```text
✓ URL change suspends a PENDING delivery → state=SUSPENDED
✓ suspended deliveries are not dispatchable → eligible=0
✓ worker cannot claim a suspended delivery
✓ suspension emitted no HTTP request → calls=0
✓ suspension records the replaced endpoint URL
✓ seed claim for retry-pending succeeded
✓ delivery is RETRY_PENDING before the next change → state=RETRY_PENDING
✓ URL change suspends a RETRY_PENDING delivery → state=SUSPENDED
✓ in-flight delivery is claimed as IN_PROGRESS
✓ URL change suspends an IN_PROGRESS delivery → state=SUSPENDED
✓ suspension clears the in-flight lease
✓ stale worker completion is fenced by suspended state
✓ fenced in-flight attempt is recorded as INTERRUPTED
✓ concurrent claim + URL change leaves no dispatchable delivery
✓ concurrent claim + URL change emitted no HTTP request
✓ four deliveries are suspended before restart
✓ suspension survives a process/client restart
✓ historical attempt is preserved across suspension
✓ failed transaction rolls back the URL change
✓ failed transaction rolls back the suspension
✓ cross-tenant resolution is rejected
✓ resume without matching confirmation is rejected
✓ changed-recipient resume requires explicit acknowledgement
✓ explicitly confirmed resume succeeds
✓ resumed delivery returns to PENDING
✓ resume clears the suspension context
✓ secret rotation does not resume suspended deliveries
```

**Garantías demostradas:**

- **Atomicidad.** `updateWebhookDestination` ejecuta la actualización de
  `endpointUrl` y la suspensión de entregas dentro de una única
  `prisma.$transaction`. Un fallo revierte ambos (rollback verificado contra
  PostgreSQL real). No existe estado confirmado donde la URL nueva sea visible
  mientras hay entregas aún despachables.
- **Cobertura de estados.** La suspensión incluye `PENDING`, `RETRY_PENDING`
  **e** `IN_PROGRESS`, limpiando `leaseOwner`/`leaseExpiresAt`. Los intentos
  abiertos se registran como `INTERRUPTED`.
- **Fencing.** Un worker obsoleto con un lease ya limpiado no puede completar
  (`completeDeliveryAttempt` exige `state='IN_PROGRESS'` y coincidencia de
  `leaseOwner`), por lo que no puede sobrescribir el estado suspendido ni
  redirigir trabajo en curso a la URL de reemplazo.
- **Concurrencia.** Un claim concurrente y un cambio de URL no dejan ninguna
  entrega despachable y no emiten tráfico HTTP.
- **Persistencia.** Las entregas suspendidas sobreviven una reconexión del
  cliente (`$disconnect`/`$connect`).
- **Resolución administrativa.** `resolveSuspendedWebhookDeliveries` exige la
  URL actual confirmada explícitamente; si difiere de la URL reemplazada en la
  suspensión, requiere `acknowledgeRecipientChange: true`. Un resume masivo no
  implica permiso para redirigir entregas históricas a un destinatario
  distinto. El rechazo cross-tenant devuelve `not_found`. La autorización de
  tenant (`requireWebhookDestinationAdminApi`) rechaza a `AGENT` y a
  administradores sin membresía (verificado en la suite unitaria).
- **Aislamiento de rotación de secreto.** Rotar el secreto no reanuda entregas
  suspendidas.

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
- Resolución del host (una sola vez por dispatch) → filtro de IPs
  privadas/loopback/link-local/ULA.
- Sin follow de 3xx.

### 12. Seguridad DNS rebinding

```text
✓ literal loopback hostname is rejected as DNS rebinding surface
✓ literal 127.0.0.1 URL is rejected as DNS rebinding surface
✓ DNS is resolved exactly once per dispatch attempt → calls=1
✓ connection is pinned to the validated address → public=1
✓ rebinding cannot reach the post-validation private address → private=0
✓ pinned rebinding request is accepted → status=accepted
```

La defensa es **en tiempo de conexión**, no sólo de hostname:

- `resolveSafeUrl` resuelve el host **una sola vez** por intento y valida
  todas las direcciones contra `isPrivateIp`.
- `postJson` fija el socket a la dirección validada mediante un callback
  `lookup` que ignora cualquier re-resolución posterior (respetando
  `all: true` para happy-eyeballs). Un resolvedor que cambie de pública a
  privada después de la validación no puede redirigir la conexión.
- Se demostró con dos receptores loopback (dirección validada vs. dirección
  privada posterior) y un resolvedor inyectado que cambia la respuesta: la
  conexión aterriza en la dirección validada y la privada recibe cero
  conexiones.

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
| `npm test` | 65 archivos, 695/695 tests verdes |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint .` | exit 0, 0 errors, 0 warnings |
| `npx prisma validate` | schema válido |
| `npx prisma migrate status` | 21 migraciones, DB up to date |
| `npx next build` | **NOT PASS — preexistente**. `✓ Compiled successfully`, pero el prerender de `/login` y `/_global-error` falla con `TypeError: Cannot read properties of null (reading 'useState')` en `src/components/providers.tsx:9` (código sin cambios en esta tarea). El fallo se reproduce idénticamente en `2c4b339` sin esta remediación. Requiere actualización de framework fuera de scope. |
| `git diff --check` | exit 0 |
| `npx tsx test/integration/era3-integration-certification.test.ts` | 88/88 checks verdes |
| `npx tsx test/integration/canonical-event-fanout.test.ts` | 22/22 checks verdes |
| `npx tsx test/integration/canonical-delivery-state.test.ts` | 19/19 checks verdes |
| `npx tsx test/integration/webhook-destinations-postgres.test.ts` | 22/22 checks verdes |
| `npx tsx test/integration/canonical-event-outbox.test.ts` | 12/12 checks verdes |

## Política de cambios de endpoint para entregas pendientes

La fila `CanonicalEventDelivery` se materializa en el fanout con el
`destinationId` estable y su fecha de creación. Sobre esa base:

- **Cambio de secreto:** no mueve, suspende ni reanuda entregas. El dispatch
  firma con el secreto vigente; el HMAC verifica contra el nuevo y falla
  contra el viejo (sección 10).
- **Cambio de URL:** suspende atómicamente todas las entregas despachables
  (`PENDING`, `RETRY_PENDING`, `IN_PROGRESS`) del destino en la misma
  transacción que actualiza `endpointUrl`, registrando la URL reemplazada en
  `WebhookDestination.deliverySuspensionUrl`. Ninguna entrega se redirige al
  destinatario nuevo sin acción administrativa explícita (sección 10b).
- **Resolución administrativa:** reanudar exige confirmar la URL actual; si
  difiere de la URL reemplazada, exige además `acknowledgeRecipientChange`.
  Sólo `ADMIN`/`SYSTEM_ADMIN` con membresía en el tenant pueden resolver;
  `AGENT` y cross-tenant se rechazan.
- **Histórico:** `CanonicalEventDeliveryAttempt` conserva cada intento; los
  intentos abiertos se marcan `INTERRUPTED` al suspenderse.

Se descarta el rediseño de un modelo de snapshot por entrega: la garantía se
obtiene con atomicidad + fencing + suspensión, sin nuevos formatos de
persistencia durable ni cambios al contrato de eventos.

## Limitaciones conocidas

1. **DNS rebinding con servidor DNS externo real:** la prueba usa un
   resolvedor inyectado que cambia de pública a privada tras la validación,
   junto a dos receptores loopback. Demuestra la fijación en tiempo de
   conexión, pero no levanta un servidor DNS instrumentado.
2. **Snapshot de configuración por entrega:** el relay no versiona
   configuración por entrega; un cambio de URL suspende (no reescribe) las
   entregas existentes. Si la auditoría exige configuración histórica por
   entrega, hará falta un snapshot versionado en `CanonicalEventDelivery`.
3. **Paginación de destinos:** el fanout soporta `maxDestinations` y
   `afterId` pero la API pública no expone `afterId` todavía. Si un
   tenant supera el tope, hace falta iterar invocando varias veces.
4. **Worker de producción:** la integración end-to-end se ha verificado
   con un worker driver dentro del test. La capa de transporte y el
   state machine son los mismos que usará el worker de producción, pero
   la integración operativa (claim loop, lease renewal, schedule) no se
   ha certificado contra un daemon porque ese despliegue está fuera de
   scope.
5. **Build de Next.js:** `npx next build` falla en el prerender de `/login`
   y `/_global-error` por una incompatibilidad React 19.2.8 / Next 16.3.4
   preexistente (idéntica en `2c4b339` sin esta remediación). No afecta al
   relay ni a esta remediación; requiere actualización de framework fuera de
   scope.

## Estado de activación en producción

**Desactivado.** La superficie existe, las pruebas PostgreSQL + HTTP
verifican el contrato end-to-end y los gates de seguridad de
WA-ERA3-07-SECURITY-REMEDIATION pasan. Ningún lazo automático, daemon, cron
ni scheduler de producción invoca todavía el relay.

`runCanonicalDeliveryWorker` puede invocarse explícitamente desde código
(como hace el test), pero ningún lazo automático lo activa. La activación
queda para WA-ERA3-CERT tras la decisión explícita de producción.

**ERA 3 NO está FROZEN.** Esta remediación no declara congelación de era:
el build de Next.js queda en rojo por una causa preexistente y fuera de
scope, y la activación de producción sigue pendiente de una unidad dedicada.
