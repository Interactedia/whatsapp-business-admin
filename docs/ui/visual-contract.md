# UI BASELINE v1.0 — Contrato Visual de WhatsApp Business Admin

> **Estado:** BASELINE — Contrato formalizado a partir de patrones activos del repositorio.
> No es un design system nuevo; es la formalización de lo que ya existe y opera.

## 1. Principio rector

Reutilizar componentes y tokens existentes antes de crear nuevos primitives.
El contrato documenta los patrones activos verificados en runtime.

---

## 2. Token del sistema de diseño

Tokens activos en `src/app/globals.css` (CSS custom properties):

| Token | Light | Dark | Propósito |
|-------|-------|------|-----------|
| `--background` | `hsl(0 0% 100%)` | `hsl(222 24% 9%)` | Fondo principal |
| `--foreground` | `hsl(222 20% 14%)` | `hsl(210 20% 92%)` | Texto principal |
| `--primary` | `hsl(168 76% 30%)` | `hsl(160 70% 42%)` | Accent teal (WhatsApp) |
| `--secondary` | `hsl(210 20% 96%)` | `hsl(217 20% 18%)` | Superficies secundarias |
| `--muted` | `hsl(210 20% 96%)` | `hsl(217 20% 16%)` | Fondos sutiles |
| `--muted-foreground` | `hsl(215 14% 45%)` | `hsl(215 16% 60%)` | Texto secundario |
| `--destructive` | `hsl(0 72% 48%)` | `hsl(0 62% 46%)` | Acciones destructivas |
| `--border` | `hsl(214 18% 89%)` | `hsl(217 20% 20%)` | Bordes |
| `--input` | `hsl(214 18% 89%)` | `hsl(217 20% 22%)` | Inputs |
| `--ring` | `hsl(168 76% 30%)` | `hsl(160 70% 42%)` | Foco |
| `--card` | `hsl(0 0% 100%)` | `hsl(222 22% 12%)` | Superficie de card |
| `--card-foreground` | `hsl(222 20% 14%)` | `hsl(210 20% 92%)` | Texto en card |
| `--accent` | `hsl(210 20% 94%)` | `hsl(217 20% 20%)` | Hover/accent |
| `--accent-foreground` | `hsl(222 20% 20%)` | `hsl(210 20% 92%)` | Texto en accent |
| `--radius` | `0.5rem` | — | Radio de borde compartido |

Tokens específicos de conversación (Inbox):

| Token | Light | Dark | Propósito |
|-------|-------|------|-----------|
| `--conv-canvas` | `hsl(210 20% 96%)` | `hsl(222 20% 7%)` | Lienzo de conversación |
| `--conv-card` | `hsl(0 0% 100%)` | `hsl(222 22% 12%)` | Card de conversación |
| `--conv-hover` | `hsl(210 16% 93%)` | `hsl(217 20% 16%)` | Hover en conversación |
| `--conv-selected` | `hsl(160 55% 95%)` | `hsl(160 30% 16%)` | Conversación seleccionada |
| `--unread-badge` | `hsl(174 76% 36%)` | `hsl(174 76% 40%)` | Badge de no leído |

**Regla:** Usar tokens semánticos. No hardcodear `bg-slate-100` cuando existe `--accent` o `--muted`.

---

## 3. PageHeader — Encabezado de página

**Ubicación:** `src/components/shell/page-header.tsx`

### Size: `default` (encabezado de página)

```jsx
<PageHeader
  title="Título de la página"          // text-2xl font-semibold tracking-tight
  description="Descripción opcional"    // text-sm leading-relaxed text-muted-foreground
  actions={<Button>Acciones</Button>}  // opcional, alineado a la derecha
/>
```

Padding: `px-4 py-5 sm:px-6 sm:py-5` — 16px móvil, 24px desktop.

### Size: `compact` (encabezado de sección)

```jsx
<PageHeader
  title="Nombre de sección"             // text-sm font-semibold
  description="Subtítulo"              // text-xs text-muted-foreground
  actions={<Button size="sm">Acción</Button>}
  size="compact"
/>
```

Padding: `px-3 py-3 sm:px-4 sm:py-2.5` — menor que default.

**Regla:** Usar PageHeader en toda pantalla administrativa nueva. Solo divergir con justificación funcional explícita.

---

## 4. Superficie principal — padding y contenedor

Patrón verificado en pantallas administrativas (`admin/page.tsx`, Settings):

```jsx
<main className="min-h-0 min-w-0 flex-1 overflow-auto bg-slate-50 scroll-thin">
  <PageHeader ... />
  <div className="p-4 sm:p-6">
    {/* contenido */}
  </div>
</main>
```

- `p-4 sm:p-6` — 16px móvil, 24px desktop.
- `overflow-auto` + `scroll-thin` — scroll contenido con scrollbar custom.
- `bg-slate-50` — fondo suave para pantallas administrativas.

---

## 5. Card — Superficie de contenido

**Ubicación:** `src/components/ui/card.tsx`

```jsx
<Card className="rounded-lg border bg-card text-card-foreground shadow-xs">
  <CardHeader>
    <CardTitle>Título</CardTitle>
    <CardDescription>Descripción</CardDescription>
  </CardHeader>
  <CardContent>
    {/* contenido */}
  </CardContent>
  <CardFooter>
    {/* acciones */}
  </CardFooter>
</Card>
```

Token: `bg-card` para fondo, `border` para borde visible.
**Regla:** Usar Card para agrupar contenido relacionado. No inventar divs con bordes manualmente.

---

## 6. Button — Acciones y controles

**Ubicación:** `src/components/ui/button.tsx`

Variantes (CVA):

| Variante | Uso |
|----------|-----|
| `default` | Acción primaria principal |
| `destructive` | Eliminación, acciones irreversibles |
| `outline` | Acción secundaria con borde |
| `secondary` | Acción terciaria |
| `ghost` | Navegación, acciones de bajo peso visual |
| `link` | Enlaces inline |

Tamaños:

| Size | Uso |
|------|-----|
| `default` | `h-8 px-3 py-1.5` — estándar |
| `sm` | `h-7 px-2.5 text-xs` — compactos |
| `lg` | `h-9 px-4` — botones de alta visibilidad |
| `icon` | `h-10 w-10 sm:h-8 sm:w-8` — icon-only |

**Regla:** Icon-only buttons requieren `aria-label` o `title` para accesibilidad. Usar `Button size="icon"` para controles circulares.

Estados:
- `disabled` — opacity 50%, pointer-events none (automático vía CVA)
- `loading` — agregar `disabled` + `aria-disabled` + texto "Guardando..." o similar
- Nunca simular éxito funcional en controls pendientes de backend

---

## 7. Table — Listas y tablas de datos

**Ubicación:** `src/components/ui/table.tsx`

```jsx
<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Columna 1</TableHead>
      <TableHead>Columna 2</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    <TableRow>
      <TableCell>dato</TableCell>
      <TableCell>dato</TableCell>
    </TableRow>
  </TableBody>
</Table>
```

### Responsive behavior

El wrapper `Table` aplica `responsive-table` que convierte la tabla en tarjetas en móvil:

```css
/* globals.css — comportamiento automático en < 768px */
.responsive-table tbody { display: block; }
.responsive-table thead { display: none; }
.responsive-table tbody tr {
  display: grid;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  margin-bottom: 0.75rem;
  padding: 0.75rem;
}
.responsive-table tbody td {
  display: flex;
  justify-content: space-between;
  padding: 0;
}
.responsive-table tbody td::before {
  content: attr(data-label);
  font-size: 0.6875rem;
  font-weight: 500;
  text-align: left;
  color: var(--muted-foreground);
}
```

**Regla:** Toda TableCell en columna con header visible debe tener `data-label={...}` apuntando al texto del encabezado para la conversión mobile. Verificar que la tabla es usable en < 768px.

---

## 8. Forms — Formularios

Componentes disponibles:

| Componente | Archivo | Propósito |
|------------|---------|-----------|
| `Input` | `src/components/ui/input.tsx` | Campo de texto |
| `Textarea` | `src/components/ui/textarea.tsx` | Área de texto multilínea |
| `Select` | `src/components/ui/select.tsx` | Selector desplegable (Radix) |
| `Switch` | `src/components/ui/switch.tsx` | Toggle binario |
| `Label` | `src/components/ui/label.tsx` | Etiqueta de campo |
| `SmartTagsCombobox` | `src/components/ui/smart-tags-combobox.tsx` | Tags/etiquetas |

Reglas:

1. Todo input debe tener `<Label>` asociado visualmente (`htmlFor`/`id`).
2. Mensajes de error: visibles en `text-destructive`, debajo del campo.
3. Accesibilidad teclado: todos los campos navegables con Tab.
4. Scroll: el formulario debe ser alcanzable sin que nada quede oculto tras header sticky o bottom nav.
5. Responsive: layouts de varias columnas (`grid grid-cols-1 sm:grid-cols-2`) degradan a una columna en móvil.

---

## 9. Application States — Loading, Empty, Error

### Loading

Patrón verificado en Settings y Contacts:

```jsx
// Skeleton inline o spinner
{isLoading ? (
  <div className="flex items-center gap-2 text-sm text-muted-foreground">
    <RefreshCw className="h-4 w-4 animate-spin" />
    <span>Cargando...</span>
  </div>
) : (
  // contenido real
)}
```

- Usar `animate-spin` + ícono lucide para estados de carga.
- No usar GIFs animados externos.
- Deshabilitar controles interactivos durante carga (`disabled`).

### Empty

```jsx
<div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
    <Icon className="h-5 w-5 text-muted-foreground" />
  </div>
  <div>
    <p className="text-sm font-medium text-foreground">Sin elementos</p>
    <p className="text-xs text-muted-foreground">Agrega tu primer elemento para comenzar.</p>
  </div>
</div>
```

- Usar ícono + texto + acción opcional ("Agregar...").
- Nunca mostrar una tabla vacía sin contexto.

### Error

```jsx
<div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
  <XCircle className="h-6 w-6 text-destructive" />
  <p className="text-sm font-medium text-destructive">Error al cargar</p>
  <Button variant="outline" size="sm" onClick={() => refetch()}>
    Reintentar
  </Button>
</div>
```

- Mensaje de error visible, no toast only.
- Incluir acción de reintento cuando sea idempotente.

---

## 10. Dialog — Modales y confirmaciones

**Ubicación:** `src/components/ui/dialog.tsx` (Radix)

```jsx
<Dialog open={open} onOpenChange={setOpen}>
  <DialogTrigger asChild>
    <Button>Abrir</Button>
  </DialogTrigger>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Título</DialogTitle>
    </DialogHeader>
    {/* contenido */}
    <DialogFooter>
      <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
      <Button onClick={handleConfirm}>Confirmar</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

- `DialogFooter` con acciones: cancelar a la izquierda, confirmar a la derecha.
- Accesibilidad: cierre con Escape, foco atrapado, `aria-modal="true"`.

---

## 11. Responsive — Puntos de rotura

| Breakpoint | Ancho | Patrón de layout |
|------------|-------|------------------|
| `< 640px` | móvil | una columna, tarjetas apiladas, table→cards |
| `640px - 1023px` | tablet | dos columnas cuando aplique |
| `>= 1024px` | desktop | tres+ columnas, sidebar visible |

Patrón verificado:

```jsx
<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
```

- Sidebar colapsa en < 1024px (mobile overlay).
- Header de tabla oculta en < 768px, datos como tarjetas.
- Formularios pasan de multi-columna a single-column en < 640px.

**Regla:** No basta que no haya overflow horizontal. El contenido debe seguir siendo utilizable (legible, interactivo) en cada breakpoint.

---

## 12. Accessibility — Requisitos mínimos

1. **Navegación por teclado:** Tab/shift+Tab entre todos los controles interactivos.
2. **Foco visible:** `focus-visible:ring-2 focus-visible:ring-ring` en todo focus ring.
3. **Labels:** todo input tiene `<Label>` asociado. Icon-only buttons tienen `aria-label`.
4. **Contraste:** usar tokens existentes que garantizan contraste WCAG AA. No inventar colores fuera de tokens.
5. **Dialogs:** cierre con Escape, foco atrapado, `aria-modal`.
6. **Dropdowns/Selects:** usar Radix (`Select`, `DropdownMenu`) que manejan a11y nativamente.
7. **Tabs:** usar `<Tabs>` de `src/components/ui/tabs.tsx` (Radix) para paneles tabulados.

---

## 13. Language — Idioma de interfaz

- **Idioma inicial/default:** español (ES).
- **Soporte planificado:** español (ES) + inglés (EN).
- **i18n:** **no implementar todavía**. Esta tarea solo establece el contrato.

Qué SÍ pertenece a "system UI text" (traducible):
- Labels de botones, headers, descripciones, placeholders, mensajes de error/warning/empty.
- Navegación, títulos de página, tooltips.
- Textos de estado (Cargando, Error, Sin resultados...).

Qué NO se traduce (datos de negocio):
- Nombres de contactos, mensajes de WhatsApp, contenido de conversaciones.
- Nombres de tenant, nombres de usuario, tags personalizados.
- Valores de campos de negocio, respuestas de plantillas.

**Regla:** Los archivos de mensajes de interfaz (`src/messages/` o equivalente futuro) contendrán las cadenas traducibles. Las pantallas usan `t("key")` cuando i18n esté implementado. Hasta entonces, textos en español directamente en componentes.

---

## 14. Excepciones explícitas de layout

### 14.1 Inbox

**Patrón:** layout especializado de tres columnas full-height.

No imponer el patrón `PageHeader + p-4 sm:p-6 + Card` de pantallas administrativas.
Inbox tiene su propia arquitectura:
- Tres columnas: canvas, thread list, conversation panel.
- `conv-canvas` / `conv-card` / `conv-selected` tokens.
- `wa-wallpaper` background en conversation panel.
- Scroll vertical independiente por columna.

**Referencia:** `src/app/(app)/t/[tenantId]/conversations/**`, CSS en `globals.css`:
```css
/* WA-UI-012: conv-canvas / conv-card pattern */
--conv-canvas: hsl(210 20% 96%);  /* light */
--conv-card: hsl(0 0% 100%);       /* card */
--conv-hover: hsl(210 16% 93%);
--conv-selected: hsl(160 55% 95%);
```

**Regla absoluta:** cualquier cambio en Inbox debe preservar la arquitectura de tres columnas. No refactorizar a contenedor de página administrativa.

### 14.2 Login

**Patrón:** puede tener composición propia.

Login puede tener layout centrado, fondo diferenciado, branding prominente.
**Debe preservar:** tipografía, tokens de color, Button, Input, y lenguaje de sistema.

### 14.3 Flows / Builders

Builders de flujos complejos pueden requerir layout especializado con canvas, panel lateral, toolbar.
Justificación: función, no legacy accidental.

---

## 15. Controles pendientes de backend

El contrato distingue tres estados de implementación:

| Estado | Descripción | Indicador visual |
|--------|-------------|------------------|
| **Visual implemented** | El control se renderiza | Sin indicador especial; el control es visible |
| **Functional verified** | Backend existe y responde | El control opera correctamente |
| **Operative** | Produccisón lista | QA passed, stakeholder approved |

**Regla:** Un control visualmente terminado pero sin backend verificado:
- NO debe simular éxito (no toast "Guardado" automático).
- PUEDE mostrar estado de carga real (`isPending`).
- PUEDE mostrar placeholder de datos ilustrativos con comentario en código (ver `settings-client.tsx:944`).
- El estado se documenta en el componente: `// TODO(WA-BACKEND): conectar a API cuando backend esté verificado`

**No introducciones de mock de éxito:**
- Un botón "Guardar" que muestre "¡Guardado!" sin backend real.
- Datos de ejemplo que parezcan producción.
- Estados de éxito sin verificación funcional.

---

## 16. Políticas de componentes

### 16.1 Reutilización obligatoria

Antes de crear un nuevo primitive:

1. ¿Existe componente en `src/components/ui/`? → Usarlo.
2. ¿Existe componente en `src/components/`? → Usarlo.
3. ¿Existe patrón documentado en este contrato? → Seguirlo.
4. ¿Necesito algo genuinamente nuevo? → Justificar en la tarea y crear en `src/components/` con prefijo del dominio.

### 16.2 No duplicar

- No crear `src/components/ui/data-table.tsx` si `Table` de shadcn cubre la necesidad.
- No crear `src/components/ui/page-header.tsx` fuera de `src/components/shell/page-header.tsx`.
- No hardcodear colores si existe token semántico.

### 16.3 No crear design system paralelo

Este contrato NO es un nuevo design system. Es la formalización de shadcn/ui + tokens Tailwind existentes. No crear `src/design-system/`, no duplicar tokens, no inventar convenciones de naming fuera de las existentes.

---

## 17. Roadmap — Frontera UI / Backend

```
WA-UI-CLOSURE
    │
    ├── UI BASELINE v1.0 FROZEN ← este documento
    │
    └── WA-UI-CLOSURE-01..UI-5 (tareas de corrección visual)
              │
              ▼
         UI BASELINE v1.0 CERTIFIED
              │
              ▼
    WA-BACKEND-COMPLETION (conectividad de controles pendientes)
```

- **UI BASELINE v1.0 FROZEN:** contrato publicado; las tareas UI-1..UI-5 lo usan como criterio de aceptación.
- **UI BASELINE v1.0 CERTIFIED:** todas las pantallas pasan el contrato visual verificado.
- **WA-BACKEND-COMPLETION:** backend conectado a controles que antes eran pending.

**Esta tarea NO declara UI BASELINE v1.0 FROZEN.** Solo crea el contrato formal que será congelado en la siguiente tarea aprobada.

---

## 18. Artefactos de referencia

| Artefacto | Ubicación |
|-----------|-----------|
| Contrato visual | `docs/ui/visual-contract.md` |
| AGENTS.md | `AGENTS.md` |
| Tokens/CSS | `src/app/globals.css` |
| PageHeader | `src/components/shell/page-header.tsx` |
| Shell | `src/components/shell/app-shell.tsx` |
| Button | `src/components/ui/button.tsx` |
| Card | `src/components/ui/card.tsx` |
| Table | `src/components/ui/table.tsx` |
| Input | `src/components/ui/input.tsx` |
| Dialog | `src/components/ui/dialog.tsx` |
| Tabs | `src/components/ui/tabs.tsx` |
| ADRs | `docs/adr/` |

---

## 19. Checklist de revisión de tarea UI

Al recibir una tarea de UI, verificar:

- [ ] ¿La pantalla ya existe en el repositorio? ¿Sigue el patrón de PageHeader + padding?
- [ ] ¿Los componentes usados están en `src/components/ui/` o `src/components/shell/`?
- [ ] ¿Los colores usan tokens semánticos (`--primary`, `--muted`, etc.)?
- [ ] ¿Los estados loading/empty/error están implementados?
- [ ] ¿La tabla tiene `data-label` en cada Cell para responsive?
- [ ] ¿Los icon-only buttons tienen `aria-label`?
- [ ] ¿El layout es usable en móvil (test: viewport 375px)?
- [ ] ¿El formulario no deja campos ocultos tras header/footer?
- [ ] ¿Los controles pendientes de backend no simulan éxito?
- [ ] ¿Se preserva la excepción de layout si es Inbox?

