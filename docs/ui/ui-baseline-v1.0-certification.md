# UI BASELINE v1.0 — Certificación y congelamiento

## Estado

**FROZEN** — UI BASELINE v1.0 certificada.

Certificación documental y de evidencia consolidada. No es una re-auditoría
funcional ni autoriza trabajo nuevo de UI.

## Fecha

2026-10-17.

## Commit de referencia

- Baseline certificado: `5a76561` (`fix(settings,i18n): WA-UI-CLOSURE-22 add settings.loading translation`), HEAD de `main` al iniciar esta certificación.
- Commit de certificación: el commit atómico creado por la tarea `WA-UI-CLOSURE-23` (ver `RUN_REPORT`).
- No se creó tag de release.

## Commits incluidos

| Tarea | Commit | Alcance certificado |
|-------|--------|---------------------|
| WA-UI-CLOSURE-00 | `073a80c` | Contrato visual UI BASELINE v1.0 |
| WA-UI-CLOSURE-01 | `8100355` | Settings: accesibilidad de scroll |
| WA-UI-CLOSURE-02 | `8188fd4` | Settings: Select y labels |
| WA-UI-CLOSURE-03 | `184ef99` | Contacts: correcciones visuales |
| WA-UI-CLOSURE-05 | `b2fbf61` | Base i18n ES/EN |
| WA-UI-CLOSURE-06 | `d963635` | Templates ES/EN |
| WA-UI-CLOSURE-07 | `9db2c27` | Flows ES/EN |
| WA-UI-CLOSURE-08 | `1cbef1d` | Submissions ES/EN |
| WA-UI-CLOSURE-09 | `6e749e9` | Broadcasts ES/EN |
| WA-UI-CLOSURE-10 | `e931e31` | Users ES/EN |
| WA-UI-CLOSURE-11 | `13f9be6` | Webhooks ES/EN |
| WA-UI-CLOSURE-12 | `4424dd5` | Developer ES/EN |
| WA-UI-CLOSURE-13 | `214b56c` | Logs ES/EN |
| WA-UI-CLOSURE-14 | `03f8c58` | Tenant Dashboard ES/EN |
| WA-UI-CLOSURE-15 | `8f0062f`, `e796f12` | Admin ES/EN y restauración de cambios fuera de alcance |
| WA-UI-CLOSURE-16 | `dd43d33` | Tenants Admin ES/EN |
| WA-UI-CLOSURE-17 | `4164a50` | Queue Observability ES/EN |
| WA-UI-CLOSURE-18 | `862d5da`, `8e8ba02` | Login ES/EN y selector de idioma |
| WA-UI-CLOSURE-19 | `00aad4d` | Inbox ES/EN |
| WA-UI-I18N-TERMINOLOGY-01 | `c5c9964` | Terminología ES: organización |
| WA-UI-CLOSURE-20 | `a4de368` | Contacts ES/EN |
| WA-UI-CLOSURE-21 | `2d7fb16` | Settings ES/EN |
| WA-UI-CLOSURE-22 | `ce2d44a`, `5a76561` | Contacts aria-labels y Settings loading |

Los seis commits exigidos por el packet (`00aad4d`, `c5c9964`, `a4de368`,
`2d7fb16`, `ce2d44a`, `5a76561`) existen y son ancestros de HEAD.

## Alcance congelado

- Diseño visual y tokens del contrato visual.
- Navegación y estructura de shell/sidebar.
- Componentes compartidos de `src/components/ui/` y `src/components/shell/`.
- i18n ES/EN: diccionarios, cookie `wa-locale`, cambio inmediato de idioma y
  `<html lang>`.
- Terminología: `organización` en ES, `tenant` en EN; nombres técnicos y datos
  de negocio no se traducen.
- Responsive aprobado (desktop y 375px).
- Accesibilidad básica aprobada (foco visible, labels, `aria-label`, teclado,
  dialogs).

## Evidencias reutilizadas

Evidencia existente (no re-ejecutada en esta tarea):

- Historial Git de WA-UI-CLOSURE-00..22 y WA-UI-I18N-TERMINOLOGY-01.
- Capturas locales de recorridos previos, no versionadas: login/dashboard,
  contacts, inbox desktop/mobile, flows builder desktop/mobile, developer
  desktop/mobile, logs desktop/mobile, users y snapshot inicial de página.
- Certificaciones funcionales y visuales emitidas por las tareas anteriores.

Comprobaciones nuevas de esta tarea (solo estáticas):

- Existencia y ancestralidad de los commits de referencia.
- `git status` y `git diff --check`.
- Existencia de `docs/ui/visual-contract.md`, `src/messages/es.ts`,
  `src/messages/en.ts` y `src/messages/index.ts`.
- Inspección de código de i18n: `LOCALE_COOKIE = "wa-locale"`, provider de
  cliente con actualización inmediata y persistencia en cookie.
- Inspección de terminología: 40 ocurrencias de `organización/organizaciones`
  en ES y 99 de `tenant(s)` en EN, incluyendo identificadores técnicos que no
  se traducen.

No se repitieron recorridos completos de navegador ni pruebas funcionales.

## Exclusiones

El congelamiento **no** incluye:

- Backend, APIs, Prisma o base de datos.
- Infraestructura, servicios, integraciones o webhooks.
- Correcciones funcionales autorizadas.
- Nuevas funcionalidades aprobadas expresamente.
- Tags de release.

## Limitaciones conocidas

- La certificación se basa en evidencia consolidada de tareas previas; no se
  ejecutó una nueva pasada visual completa (así lo indica el packet).
- `docs/ui/visual-contract.md` §13 conserva la frase histórica "i18n: no
  implementar todavía". Está superada por WA-UI-CLOSURE-05..22; el contrato
  operativo de i18n es el descrito en este documento. Una actualización
  documental de esa sección requiere una tarea autorizada.
- Las capturas de evidencia local siguen sin track y no forman parte del commit
  de certificación.
- No se creó tag de release.

## Reglas de modificación

1. Ningún trabajo posterior puede modificar contratos visuales, navegación o
   i18n fuera de un alcance explícitamente autorizado.
2. Los bugs reales siguen permitidos si la corrección es local, está
   justificada y se verifica en navegador (desktop y 375px).
3. Todo cambio de UI debe consultar `docs/ui/visual-contract.md` y preservar
   tokens, componentes compartidos, terminología y claves i18n existentes.
4. No se añaden patrones visuales nuevos sin alcance explícito.
5. No se debilita accesibilidad, responsive ni comportamiento de idioma para
   obtener PASS.
6. Las mejoras futuras aprobadas expresamente por el usuario no quedan
   bloqueadas por este congelamiento.

## Relación con AGENTS.md

La regla de congelamiento se incorpora en `AGENTS.md` (sección
"UI BASELINE v1.0 — FROZEN"). `AGENTS.md` sigue siendo el contrato de trabajo;
este documento es la certificación de la baseline y su frontera de cambios.
