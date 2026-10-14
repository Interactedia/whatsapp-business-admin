# WA-ERA3-06 — Tenant webhook destinations

## Estado

Implementado como configuración administrativa tenant-scoped. La entrega automática de producción sigue desactivada: WA-ERA3-06 solo registra destinos, firma envíos HTTP cuando se invoca el transporte y permite pruebas sintéticas explícitas.

## Modelo de datos

`WebhookDestination` pertenece exactamente a un `Tenant` mediante `tenantId` y usa un `id` estable independiente de `endpointUrl`. Cambiar la URL no cambia el `destinationId`; los registros históricos de `CanonicalEventDelivery` y `CanonicalEventDeliveryAttempt` no se reescriben ni se eliminan.

Campos principales:

- `id`: identidad estable del destino.
- `tenantId`: propiedad obligatoria.
- `name`: nombre humano.
- `endpointUrl`: URL HTTPS configurada.
- `enabled`: elegibilidad para nuevos envíos explícitos.
- `retiredAt`: retiro blando; un destino retirado no se habilita ni se usa para nuevas entregas.
- `subscriptions`: catálogo permitido de eventos canónicos.
- `signingSecretEnc`: secreto cifrado con AES-256-GCM usando `ENCRYPTION_KEY`.
- `secretVersion`: versión de rotación.
- `lastTestAt`: control local de rate limit para pruebas sintéticas.

## Autorización

Todas las APIs usan `requireUser()` y `requireTenantAdminApi(userId, tenantId)`:

- `SYSTEM_ADMIN` puede administrar cualquier tenant con contexto explícito en la ruta `/api/tenants/:tenantId/...`.
- `ADMIN` requiere membresía activa en el tenant.
- `AGENT` recibe rechazo del guard central.
- El repositorio filtra siempre por `{ tenantId, id }`; el filtrado de UI no es la frontera de seguridad.

## APIs

Base: `/api/tenants/:tenantId/webhook-destinations`

- `GET /`: listar destinos.
- `POST /`: crear destino y devolver el secreto solo en esa respuesta.
- `GET /:destinationId`: leer destino sin secreto.
- `PUT /:destinationId`: actualizar nombre, URL, estado o suscripciones sin cambiar `id`.
- `DELETE /:destinationId`: retiro blando.
- `POST /:destinationId/enable`: habilitar si no está retirado.
- `POST /:destinationId/disable`: deshabilitar.
- `POST /:destinationId/rotate-secret`: rotar secreto y devolver el nuevo valor una sola vez.
- `POST /:destinationId/test`: enviar payload sintético marcado como test.
- `GET /:destinationId/history?limit=n`: historial acotado sin cuerpos, secretos ni cabeceras sensibles.

## Suscripciones

Solo se aceptan los tipos de `ExternalEvent v1`:

- `inbound.message.received`
- `outbound.message.accepted`
- `outbound.message.status_changed`
- `conversation.changed`

Arrays vacíos, duplicados o eventos desconocidos se rechazan por validación.

## URL y SSRF

La configuración exige HTTPS. La entrega HTTP conserva la validación existente en `delivery.ts`: resolución DNS, rechazo de direcciones privadas/loopback/link-local/reservadas en producción, no seguir redirects y timeout acotado. La resolución se repite en tiempo de entrega para reducir riesgo de DNS rebinding.

## Firma HMAC

Cuando un destino incluye secreto, el transporte añade:

- `X-WBA-Timestamp`: Unix epoch seconds.
- `X-WBA-Signature`: `v1=<hex hmac-sha256>`.

Base firmada: bytes exactos enviados como cuerpo, prefijados por `${timestamp}.`. La verificación de ejemplo usa comparación constante y ventana de replay por timestamp.

## Secretos

Los secretos se generan con `crypto.randomBytes(32)` y se cifran antes de persistir. Las APIs de lectura nunca devuelven `signingSecretEnc` ni el secreto plano. Crear y rotar son las únicas operaciones que devuelven el secreto nuevo una sola vez.

## Enable/disable/retiro

Deshabilitar o retirar evita selección para nuevas entregas explícitas mediante `destinationForDispatch()`. Los registros históricos permanecen disponibles. Las entregas pendientes existentes no se eliminan ni se reescriben; la activación automática de fanout queda para WA-ERA3-07, donde debe definirse la política completa de pending/retry frente a cambios de URL o retiro.

## UI

Ruta tenant-scoped: `Configuracion -> Integraciones -> Webhooks salientes`, implementada como `/t/:tenantId/settings/webhooks` en el shell existente. La página permite crear destinos, seleccionar eventos, habilitar/deshabilitar, retirar, rotar secreto, invocar prueba sintética y consultar historial.

## Dependencia WA-ERA3-07

WA-ERA3-07 debe certificar integración end-to-end y, si se aprueba producción, conectar fanout de outbox por destino sin romper los invariantes anteriores.
