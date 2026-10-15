# ADR-0009 — Control de Copilot, handoff humano y seguimiento automático

- Identificador: `ADR-WA-COPILOT-001`
- Proyecto: WhatsApp Business Admin
- Status: **Proposed** (PROPUESTO — pendiente de aprobación formal)
- Date: 2026-10-14
- Alcance: conversaciones tenant-scoped, automatización por IA y recordatorios por falta de respuesta del cliente
- Contexto visual: simulación del Inbox con Copilot, handoff y seguimiento aprobada por producto

## 1. Contexto y problema

WhatsApp Business Admin es la autoridad sobre las conversaciones y el envío por el canal. Un agente externo (por ejemplo, Mastra) puede atender al cliente, y un humano puede asumir el control. Adicionalmente, una conversación puede requerir un recordatorio si el cliente deja de responder después de una pregunta o solicitud, con independencia de quién redactó el mensaje anterior.

El switch visual, por sí solo, no es control suficiente. Workers, integraciones y respuestas tardías deben obedecer un estado autoritativo, persistente y verificado en el momento de autorizar el envío.

## 2. Decisiones aprobadas

### D1. Autoridad de atención por conversación

Cada conversación tiene un estado de Copilot habilitado o deshabilitado, persistido de manera tenant-scoped. ON permite que el agente designado para el tenant/canal responda automáticamente cuando sea apropiado; OFF reserva la atención al humano. ON no obliga a enviar respuesta ni identifica por sí mismo qué agente está asignado. La plataforma gobierna la autorización, no el runtime de IA.

### D2. Toma de control y handoff

Un handoff confirmado apaga Copilot para esa conversación y la deja bajo atención humana. Una intervención de envío humano con Copilot ON debe convertir el control a OFF de forma atómica respecto de la autorización de esa intervención, evitando carreras con envíos automáticos. La IA no puede volver a encender Copilot unilateralmente tras un handoff. Un operador autorizado puede devolver el control mediante una acción explícita ON, incluso para dejar la atención delegada durante un descanso.

La reactivación habilita la evaluación de nuevos eventos entrantes. No debe generar respuestas sobre mensajes históricos ni reactivar automáticamente trabajos cancelados.

### D3. Seguimiento desacoplado de Copilot

Seguimiento (follow-up) es independiente del switch Copilot. Puede permanecer habilitado cuando Copilot está ON u OFF. Su función es evaluar si procede enviar un recordatorio después de una espera de respuesta del cliente; no asigna el control de la conversación ni habilita por sí mismo a la IA para intervenir.

La política acordada como dirección de producto es activar automáticamente el seguimiento cuando la conversación queda realmente esperando al cliente, permitiendo al operador deshabilitarlo manualmente. El mero paso del tiempo o un último mensaje saliente no prueban que corresponda un recordatorio. El estado de espera debe determinarse mediante una señal operativa verificable. No se crean nuevos estados Prisma por este ADR: se inspeccionan primero los contratos reales.

### D4. Reglas de cancelación, elegibilidad y continuidad

Un mensaje entrante del cliente invalida el recordatorio pendiente correspondiente a esa espera. Cerrar o resolver una conversación, deshabilitar el seguimiento, una exclusión de contacto o una pérdida de elegibilidad también impiden el envío. Al ejecutarse un trabajo demorado se debe reevaluar el estado más reciente, no confiar en el estado que existía al programarlo.

Si un recordatorio se envía con Copilot OFF y el cliente responde después, el humano sigue siendo responsable. El recordatorio nunca enciende Copilot ni altera la asignación.

### D5. Controles de UI

En el encabezado del chat seleccionado se ubican dos switches independientes: Copilot y Seguimiento. La interfaz debe indicar el responsable actual y, cuando aplique, la espera del cliente y el próximo recordatorio. El estado de los switches procede del backend y debe tener feedback de guardado/error y permisos adecuados; un error de guardado no debe mostrar una situación falsa. En la lista de conversaciones se permite un indicador compacto de responsable, pero no un switch por tarjeta que recargue la vista.

### D6. Separación de responsabilidades

- **WhatsApp Business Admin:** fuente de verdad de conversación, pertenencia al tenant, control ON/OFF, transiciones de handoff, autorización de envíos, elegibilidad de seguimiento, idempotencia, auditoría y publicación por el canal.
- **Mastra u otro agente:** razonamiento y eventual propuesta de respuesta, contexto de negocio mediante herramientas autorizadas. No decide unilateralmente la autoridad de envío.
- **Programador/worker de follow-up:** temporización, cancelación y reevaluación de condiciones; pasa por el mismo punto de autorización de salida, no crea un bypass de envío.

## 3. Invariantes de seguridad y operación

1. **Tenant aislado:** no cruzar conversación, contacto, agente ni trabajo entre tenants y canales.
2. **Autoridad comprobada al despachar:** una respuesta IA generada con ON no se entrega si el control cambió a OFF antes de autorizar efectivamente el envío.
3. **Transiciones resistentes a carreras:** handoff, envío humano, apagado manual, reencendido y jobs en curso deben tener una política explícita de orden/versionado e idempotencia; los trabajos obsoletos se invalidan.
4. **Sin duplicados:** cada espera y recordatorio programado debe tener identidad/idempotencia que impida doble envío por reintentos o workers concurrentes.
5. **No loops ni acoso:** políticas de número máximo de recordatorios, frecuencia, horarios y opt-out deben verificarse antes de habilitar envíos automáticos.
6. **Reglas de Meta:** dentro de la ventana de atención aplican las capacidades autorizadas del canal; fuera de la ventana de 24 h se exige una plantilla aprobada y la elegibilidad/consentimiento pertinentes. No asumir que una plantilla disponible autoriza cualquier campaña o recordatorio.
7. **Auditoría:** registrar actor, instante, tenant, conversación, origen y motivo de cambio de autoridad y programación/cancelación de seguimiento.
8. **Aislamiento del entorno de desarrollo:** fixtures no deben activar trabajos de salida a Meta, webhooks o automatizaciones de producción.

## 4. Flujo esperado

- **IA en control:** mensaje entrante → se verifica Copilot ON → agente propone respuesta → plataforma revalida autorización → envía si procede → si espera al cliente, puede programar seguimiento.
- **Handoff:** agente solicita handoff → plataforma confirma transición OFF → inhibe respuestas IA pendientes no autorizadas → operador es responsable → seguimiento conserva su política independiente.
- **Humano interviene:** envío humano sobre conversación ON → control pasa a OFF como parte de la operación protegida → no pueden competir envíos automáticos.
- **Humano devuelve control:** operador autorizado activa ON → la IA puede procesar futuros entrantes; no reprocesar histórico ni reanudar pendientes viejos automáticamente.
- **Silencio del cliente:** se marca una espera elegible → scheduler programa recordatorio → llega vencimiento → reevaluación de espera, mensajes, cierre, opt-out, ventana de WhatsApp y límites → envío autorizado o cancelación.
- **Cliente contesta:** cancelar/inutilizar follow-ups de la espera; conservar Copilot ON u OFF sin cambio automático.

## 5. Decisiones pendientes antes de habilitar follow-ups reales

Estas variables no están aprobadas todavía y no deben resolverse mediante valores hardcoded arbitrarios:

1. Retraso predeterminado desde el inicio de la espera (30 minutos fue solo un ejemplo).
2. Límites de repetición: máximo de recordatorios y separaciones entre intentos.
3. Horario de atención y zona horaria aplicable por tenant/canal.
4. Fuente de intención WAITING_CUSTOMER: señal explícita humana, inferencia validada del agente o política configurable; evitar detección basada solamente en el último emisor.
5. Modalidad de mensaje: texto aprobado/predefinido al inicio; generación contextual por agente quedará para autorización posterior.
6. Privacidad/consentimiento y opt-out según política y jurisdicción.
7. Permisos exactos para alternar Copilot/seguimiento, y qué ocurre si no hay agente configurado.
8. Política de exclusiones persistentes por número (tenant + canal): decisión ya contemplada, pero implementación separada del switch por conversación.

## 6. Opciones descartadas

- Usar solamente un switch local de React: no puede gobernar procesos externos y provoca estados inconsistentes.
- Hacer que Copilot OFF cancele necesariamente los recordatorios: mezcla responsabilidad de respuesta con recuperación de conversación.
- Reencender Copilot automáticamente al recibir respuesta tras recordatorio: rompe el handoff humano.
- Programar seguimiento solo por temporizador desde cualquier mensaje saliente: produce recordatorios inapropiados.
- Permitir a Mastra enviar directamente, sin autorización de la plataforma: rompe la gobernanza y el aislamiento.

## 7. Consecuencias y criterios de verificación al reabrir la era

La reapertura no debe iniciar con implementación automática. Primero levantar inventario del runtime real: schema, Conversation, inbound/outbound, relay de webhooks, suscripciones, workers BullMQ, autorización por tenant, estados, permisos, endpoint de salida e idempotencia. Contrastar con cada decisión y clasificarla como IMPLEMENTADO / PARCIAL / AUSENTE / BLOQUEADO, con evidencia de ejecución; distinguir código disponible de operación real.

Pruebas de aceptación indispensables, usando la aplicación real y componentes propios:

- Alternar ON/OFF persiste al recargar; dos usuarios observan estado coherente.
- Handoff cambia a OFF e impide la entrega de una respuesta IA en vuelo.
- Envío humano toma control sin doble respuesta.
- Un operador autorizado devuelve ON; solo futuros entrantes pueden generar respuesta IA.
- Seguimiento ON/OFF es independiente de Copilot.
- Un nuevo mensaje cliente cancela el recordatorio antes de su salida.
- Cierre, opt-out, ventana del canal y reintentos bloquean los envíos no elegibles.
- Múltiples workers/reintentos no generan recordatorios duplicados.
- Todo conserva aislamiento tenant/canal y registro auditable.
- Las pruebas de simulación no se presentan como certificación con Meta real.

## 8. Secuencia de decisión y gobierno

1. **GUI:** diseño aprobado mediante simulación; todavía no implica implementación ni funcionamiento real.
2. **ADR:** revisar y aprobar este contrato, resolviendo las decisiones pendientes necesarias para los primeros cortes.
3. **Reapertura controlada de la era:** inventario de capacidades existentes y brechas, sin reconstrucción especulativa.
4. **Implementación acotada:** solo brechas demostradas; verificar escenarios reales antes de aceptar.

---

**Estado final de este documento: PROPUESTO.** No se declara implementado ni verificado el comportamiento Copilot/handoff/follow-up por la aprobación de la interfaz.
