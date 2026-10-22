# Segunda profesional — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que Elsa pueda dar turnos en paralelo a los de Daniela, con agenda propia, comisión por servicio y reporte de liquidación.

**Architecture:** Se introduce `Profesional` como dimensión de primera clase. El paralelismo sale de agregar `profesional_id` al `where` de las consultas de conflicto en `lib/availability.js` — no hay lógica nueva de solapamiento. La comisión se congela en el turno al reservarlo, en un único punto (`construirTurnosDeReserva`), para que cambiar un precio no altere una liquidación ya compartida.

**Tech Stack:** Node 24, Express 5, Prisma 6 + Postgres (Railway), Next 16.2.3 + React 19.2.4 (Vercel), Wassenger para WhatsApp.

**Spec:** `docs/superpowers/specs/2026-10-21-segunda-profesional-design.md`

## Global Constraints

- **Tests:** `node:test`, incluido en Node 24. **Cero dependencias nuevas.** Script `"test": "node --test test/"`.
- **Schema:** Prisma 6, sin carpeta `migrations`. Se aplica con `npx prisma db push` desde la Console de Railway. Scripts de seed se escriben en `/app`, nunca en `/tmp` (ahí no resuelve `require('@prisma/client')`).
- **Decimales:** plata `@db.Decimal(10, 2)`, porcentaje `@db.Decimal(5, 2)`.
- **ids fijos:** Daniela = `1`, Elsa = `2`. Se cargan con ids explícitos (Task 1) porque Task 3 depende de `@default(1)`.
- **Next.js:** `turnos-frontend/AGENTS.md` advierte que esta versión tiene breaking changes respecto al conocimiento previo. Antes de cualquier cambio estructural, leer la guía correspondiente en `node_modules/next/dist/docs/`.
- **Idioma:** comentarios, mensajes de error y copy de UI en español, como el resto del código.
- **Ramas:** backend en `feat/segunda-profesional` (ya creada). El frontend necesita su propia rama (Task 10).
- **No pushear ni deployar** sin pedido explícito de Mauricio.
- **No tocar** `turnos-frontend/app/reservar/reservar-page.js` (copia vieja sin trackear, código muerto).

## Review Focus

Cinco cosas que el spec implica y que ninguna tarea testearía por sí sola. Cada una tiene su test asignado a la tarea que es dueña del código.

1. **Un servicio de una profesional inactiva se sigue ofreciendo en la web.** Daniela desactiva a Elsa y sus 7 servicios siguen tomando turnos. `GET /api/servicios` filtra por `activo` del servicio, no de la profesional. → Task 7.
2. **Cambiarle el servicio a un turno desvincula la profesional y la comisión.** `PATCH /api/turnos/:id` acepta `nuevo_servicio_id` (`routes/turnos.js:511`) y `routes/admin.js:296` también; si el servicio nuevo es de otra profesional, el turno queda con el `profesional_id` y el `comision_monto` viejos, y la liquidación miente. → Task 5.
3. **`comision_pct` fuera de 0–100.** Nada valida el campo; Daniela tipea `300` y la liquidación le pide a Elsa el triple de lo facturado. → Task 7.
4. **Liquidación con rango de fechas inválido o ausente.** `desde` mayor que `hasta`, o sin parámetros, no debe devolver el histórico completo ni romperse. → Task 9.
5. **`comision_monto` nulo en un turno de una profesional con comisión.** El `?? 0` del spec §8.1 evita un `NaN` que rompe el gráfico entero de Métricas. → Task 12.

---

## File Structure

**turnos-backend**

| Archivo | Responsabilidad |
|---|---|
| `prisma/schema.prisma` | modificar — en tres pasos (Tasks 1, 3, 14) |
| `prisma/seed-profesionales.js` | crear — carga Daniela y Elsa con ids fijos |
| `lib/comisiones.js` | crear — resuelve la comisión de un turno. Puro, sin base de datos |
| `lib/availability.js` | modificar — `profesional_id` en las consultas de conflicto |
| `lib/reservas.js` | modificar — guard de profesional única + snapshot de plata |
| `lib/pagos.js` | modificar — excluir del cobro online a las profesionales con comisión |
| `routes/pagos.js` | modificar — setear `profesional_id` en el hold |
| `routes/profesionales.js` | crear — CRUD de profesionales |
| `routes/liquidacion.js` | crear — el reporte |
| `routes/servicios.js` | modificar — `profesional_id`, `comision_pct`, y el POST que descarta campos |
| `routes/horarios.js` | modificar — horarios y bloqueos por profesional |
| `routes/turnos.js` | modificar — pasar `profesionalId` a disponibilidad; resincronizar al cambiar servicio |
| `routes/admin.js` | modificar — toggle de `liquidable`; resincronizar al cambiar servicio |
| `server.js` | modificar — montar las dos rutas nuevas |
| `test/comisiones.test.js` | crear |
| `test/reservas.test.js` | crear |
| `package.json` | modificar — script `test` |

**turnos-frontend**

| Archivo | Responsabilidad |
|---|---|
| `app/admin/EquipoTab.js` | crear — pestaña Equipo: profesionales + liquidación. Código nuevo en archivo nuevo, para no engordar más `page.js` |
| `app/admin/page.js` | modificar — montar la pestaña, y los cambios en servicios, horarios, bloqueos, agenda y métricas |
| `app/reservar/page.js` | modificar — agrupar por profesional e impedir la reserva mixta |

---

## Task 1: Tabla `Profesional` y carga inicial

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/seed-profesionales.js`

**Interfaces:**
- Consumes: nada
- Produces: tabla `profesionales` con Daniela en `id = 1` y Elsa en `id = 2`. Task 3 depende de que el `id 1` exista.

- [ ] **Step 1: Agregar al schema únicamente el modelo `Profesional`**

Campos exactos en §4.1 del spec: `id`, `nombre`, `activo`, `orden`, `telefono String?`, `comision_pct_default Decimal? @db.Decimal(5, 2)`, `created_at`, `updated_at`, las cuatro relaciones inversas, y `@@map("profesionales")`.

No agregar todavía ninguna columna a los modelos existentes — eso es Task 3.

- [ ] **Step 2: Escribir `prisma/seed-profesionales.js`**

Hace `upsert` de dos filas con ids explícitos. Idempotente: correrlo dos veces no duplica ni sobreescribe `comision_pct_default` si ya tiene valor cargado a mano.

| id | nombre | comision_pct_default | telefono |
|---|---|---|---|
| 1 | Daniela | `null` | `process.env.DANIELA_TELEFONO ?? null` |
| 2 | Elsa | `null` (Daniela lo carga después desde el panel) | `null` |

Elsa arranca con `null` a propósito: un `comision_pct_default` inventado es peor que uno vacío, porque se liquidaría con un número que nadie decidió. La validación de Task 9 trata `null` como "no liquidable todavía".

- [ ] **Step 3: Aplicar el schema**

Run: `npx prisma db push`
Expected: crea `profesionales`. Ninguna tabla existente modificada.

- [ ] **Step 4: Cargar las filas y verificar**

Run: `node prisma/seed-profesionales.js`
Expected: dos filas. Verificar con `npx prisma studio` o la pestaña Data de Railway que Daniela tiene `id = 1`.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/seed-profesionales.js
git commit -m "feat(profesionales): tabla profesionales y seed inicial"
```

---

## Task 2: `lib/comisiones.js` y el harness de tests

Primera tarea con TDD de verdad: lógica pura, sin base de datos. El harness de `node:test` se monta acá porque es la primera tarea que lo necesita.

**Files:**
- Create: `lib/comisiones.js`
- Create: `test/comisiones.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `redondear` de `lib/pagos.js:11`. Existe pero **no está exportada**: agregarla a `module.exports` (`lib/pagos.js:171`). Se reutiliza, no se reescribe (§6.1 del spec), para que la comisión redondee igual que los montos de cobro y no aparezcan diferencias de un peso entre el checkout y la liquidación.
- Produces: `resolverComision(servicio, profesional, precioBase) -> { comision_pct, comision_monto }`. La usan Task 5 y Task 9.

- [ ] **Step 1: Agregar el script de test a `package.json`**

```json
"test": "node --test test/"
```

- [ ] **Step 2: Escribir los tests que fallan**

`test/comisiones.test.js`, con `node:test` y `node:assert/strict`:

```js
test('hereda el pct de la profesional cuando el servicio no tiene', () => {
  const r = resolverComision({ comision_pct: null }, { comision_pct_default: 30 }, 1000);
  assert.equal(Number(r.comision_pct), 30);
  assert.equal(Number(r.comision_monto), 300);
});

test('la excepcion del servicio le gana a la herencia', () => {
  const r = resolverComision({ comision_pct: 15 }, { comision_pct_default: 30 }, 1000);
  assert.equal(Number(r.comision_pct), 15);
  assert.equal(Number(r.comision_monto), 150);
});

test('comision_pct_default null significa que no se liquida', () => {
  const r = resolverComision({ comision_pct: null }, { comision_pct_default: null }, 1000);
  assert.equal(r.comision_pct, null);
  assert.equal(r.comision_monto, null);
});

test('comision_pct 0 en el servicio da 0 y NO hereda', () => {
  const r = resolverComision({ comision_pct: 0 }, { comision_pct_default: 30 }, 1000);
  assert.equal(Number(r.comision_pct), 0);
  assert.equal(Number(r.comision_monto), 0);
});

test('el precioBase incluye los extras', () => {
  // 50000 de servicio + 4000 de extra, 30%
  const r = resolverComision({ comision_pct: null }, { comision_pct_default: 30 }, 54000);
  assert.equal(Number(r.comision_monto), 16200);
});
```

El cuarto test es el que importa: distingue "sin excepción" de "0%". Obliga a usar `??` y no `||`.

- [ ] **Step 3: Correr los tests y verificar que fallan**

Run: `npm test`
Expected: FAIL, `Cannot find module '../lib/comisiones'`

- [ ] **Step 4: Implementar `resolverComision(servicio, profesional, precioBase)` en `lib/comisiones.js`**

Cuerpo en §6.1 del spec. `servicio.comision_pct ?? profesional.comision_pct_default`; si el resultado es `null`, devolver ambos campos en `null`. Los `Decimal` de Prisma llegan como objetos, así que convertir con `Number()` antes de multiplicar.

- [ ] **Step 5: Correr los tests y verificar que pasan**

Run: `npm test`
Expected: 5 passing

- [ ] **Step 6: Commit**

```bash
git add package.json lib/comisiones.js lib/pagos.js test/comisiones.test.js
git commit -m "feat(comisiones): helper de comision por servicio con herencia"
```

---

## Task 3: Columnas y FKs en el schema

Migración paso 3 del spec. El `@default(1)` temporal es lo que hace el backfill solo.

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Consumes: la fila `id = 1` de Task 1
- Produces: todas las columnas de §4.2. Las usan Tasks 4 a 13.

- [ ] **Step 1: Agregar las columnas**

Tabla completa en §4.2 del spec. Las tres FK obligatorias van **con `@default(1)`**:

```prisma
// En Servicio, HorarioConfig y Turno:
profesional_id Int @default(1)   // el default se quita en Task 14
```

Nullable, sin default: `BloqueCerrado.profesional_id Int?`, `ReservaPendiente.profesional_id Int?`, y en `Turno` los tres campos congelados (`precio_base`, `comision_pct`, `comision_monto`). Más `Turno.liquidable Boolean @default(true)`.

Agregar las relaciones y un `@@index([profesional_id])` en `Turno` — la agenda y el reporte filtran por esa columna constantemente.

- [ ] **Step 2: Aplicar y verificar el backfill**

Run: `npx prisma db push`
Expected: sin pérdida de datos. Verificar en la pestaña Data de Railway que los 18 servicios, los horarios y **todos** los turnos quedaron con `profesional_id = 1`.

- [ ] **Step 3: Verificar que el código viejo sigue andando**

Con el backend actual corriendo (sin desplegar nada nuevo): reservar un turno de prueba desde la web. Tiene que crearse con `profesional_id = 1` por el default. Esto es lo que permite el deploy sin downtime de §9.1.

Expected: el turno se crea y aparece en la agenda.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(profesionales): FKs y campos de comision en el schema"
```

---

## Task 4: `profesional_id` en la disponibilidad

El corazón del cambio. Sin tests automáticos: estas funciones consultan Prisma directo y mockearlo pediría refactorizar el módulo, que no está en alcance. La verificación es manual y precisa.

**Files:**
- Modify: `lib/availability.js`
- Modify: `routes/turnos.js:423-446`, `:452-481`

**Interfaces:**
- Consumes: las columnas de Task 3
- Produces: `obtenerHorariosDisponibles(fecha, duracionMinutos, servicioId, profesionalId)` y `obtenerHorariosDisponiblesBloque(fecha, duracionTotalMinutos, profesionalId)`. Las tres funciones `verificarY*` **no cambian de firma**: leen `profesional_id` del objeto de datos que ya reciben.

- [ ] **Step 1: Agregar los filtros en `lib/availability.js`**

Las cinco ubicaciones están en la tabla de §5.2 del spec. Los filtros de holds (líneas 17, 34, 59) son de Task 6: no tocarlos acá.

- `bloqueCerrado.findMany` (`:71`, `:192`) → `OR: [{ profesional_id: null }, { profesional_id: profesionalId }]`
- `horarioConfig.findMany` (`:82`, `:203`) → `profesional_id: profesionalId`
- `turno.findMany` (`:90`, `:210`) → `profesional_id: profesionalId`
- `turno.findFirst` de conflicto (`:357`, `:433`, `:473`) → `profesional_id` del turno a crear. En `verificarYReservarBloque` sale de `turnosData[0].profesional_id` (Task 5 garantiza que todos comparten profesional).

También los dos `tx.turno.count` de intercalados (`:382`, `:499`) llevan el filtro: un turno de Elsa no puede contar como intercalado dentro de un servicio de Daniela.

- [ ] **Step 2: Pasar `profesionalId` desde los endpoints**

En `routes/turnos.js` las dos rutas ya cargan el `servicio` de la base, así que el valor sale de `servicio.profesional_id` sin consultas extra. En `/disponibilidad-multi`, de `items[0].servicio.profesional_id`.

- [ ] **Step 3: Verificar el aislamiento entre agendas**

Requiere datos de prueba: un servicio asignado a `profesional_id = 2` y horarios cargados para esa profesional ese día.

| # | Prueba | Esperado |
|---|---|---|
| 1 | Turno de Elsa 15:00. Pedir disponibilidad de un servicio de Daniela ese día | 15:00 **aparece** libre |
| 2 | Turno de Elsa 15:00. Pedir disponibilidad de otro servicio de Elsa ese día | 15:00 **no aparece** |
| 3 | Reservar por API un segundo turno de Elsa a las 15:00 | `HORARIO_NO_DISPONIBLE` |
| 4 | Día sin filas de `horarios_config` para Elsa | sus servicios devuelven `horarios: []` |

- [ ] **Step 4: Verificar que no se rompió lo que ya andaba**

| # | Prueba | Esperado |
|---|---|---|
| 5 | Bloqueo con `profesional_id = null` | cierra las dos agendas |
| 6 | Bloqueo con `profesional_id = 2` | Daniela sigue disponible |
| 7 | Intercalable de Daniela: Pro lifting (id 8) + Pies simples (id 3) en una reserva | se agendan en simultáneo, igual que antes |

El 7 es el que puede romperse sin que nadie se dé cuenta hasta que una clienta lo intente.

- [ ] **Step 5: Filtrar la waitlist por profesional al cancelar**

Hallazgo del self-review, no está en el spec. Al cancelarse un turno
(`routes/turnos.js:363` y `:404`) se notifica a la waitlist con:

```js
where: { fecha, franja, activo: true, notificado: false }
```

No filtra por servicio ni por profesional. Hoy eso ya es impreciso — cancelar
una manicura avisa a alguien que esperaba pestañas — pero con dos agendas en
paralelo pasa a ser **falso**: Elsa cancela, y a una clienta que esperaba un
turno con Daniela le llega "se liberó un lugar" cuando la agenda de Daniela no
se movió.

Agregar a las dos consultas:

```js
servicio: { profesional_id: turno.profesional_id }
```

Mantiene el comportamiento actual *dentro* de una profesional (avisar entre sus
servicios de la misma franja es razonable: lo que se liberó es un rato de su
agenda) y corta el aviso cruzado.

Verificación: con una clienta anotada en la waitlist para un servicio de
Daniela, cancelar un turno de Elsa de la misma fecha y franja. **No** tiene que
llegarle el aviso. Cancelando uno de Daniela, sí.

- [ ] **Step 6: Commit**

```bash
git add lib/availability.js routes/turnos.js
git commit -m "feat(disponibilidad): agendas en paralelo por profesional"
```

---

## Task 5: Guard de profesional única y snapshot de plata

**Files:**
- Modify: `lib/reservas.js`
- Modify: `routes/turnos.js:508-580` y `routes/admin.js:296-375` (resincronización al cambiar servicio)
- Create: `test/reservas.test.js`

**Interfaces:**
- Consumes: `resolverComision` de Task 2
- Produces: `resolverProfesionalDeItems(items) -> number` exportada de `lib/reservas.js`, pura y testeable. `construirTurnosDeReserva` devuelve además `profesionalId`, y cada objeto de `turnosData` lleva `profesional_id`, `precio_base`, `comision_pct`, `comision_monto`. Task 6 usa `profesionalId` para el hold.

- [ ] **Step 1: Escribir los tests que fallan**

`test/reservas.test.js`. Se testea `resolverProfesionalDeItems`, que es pura — recibe los items ya resueltos, sin tocar la base:

```js
test('devuelve la profesional cuando todos los servicios son de la misma', () => {
  const items = [
    { servicio: { id: 20, profesional_id: 2 } },
    { servicio: { id: 21, profesional_id: 2 } }
  ];
  assert.equal(resolverProfesionalDeItems(items), 2);
});

test('rechaza servicios de distintas profesionales', () => {
  const items = [
    { servicio: { id: 3, profesional_id: 1 } },
    { servicio: { id: 20, profesional_id: 2 } }
  ];
  assert.throws(
    () => resolverProfesionalDeItems(items),
    /SERVICIOS_DE_DISTINTAS_PROFESIONALES/
  );
});

test('un solo servicio devuelve su profesional', () => {
  assert.equal(resolverProfesionalDeItems([{ servicio: { id: 3, profesional_id: 1 } }]), 1);
});
```

- [ ] **Step 2: Correr y verificar que fallan**

Run: `npm test`
Expected: FAIL, `resolverProfesionalDeItems is not a function`

- [ ] **Step 3: Implementar `resolverProfesionalDeItems(items)` en `lib/reservas.js`**

Lanza `Object.assign(new Error('SERVICIOS_DE_DISTINTAS_PROFESIONALES'), { status: 400 })`, igual que los otros errores del módulo.

- [ ] **Step 4: Correr y verificar que pasan**

Run: `npm test`
Expected: 8 passing (5 de Task 2 + 3 nuevos)

- [ ] **Step 5: Cablear el guard y el snapshot en `construirTurnosDeReserva`**

Después de resolver los `items` y antes de armar `base`: llamar a `resolverProfesionalDeItems(items)`, cargar la profesional con `prisma.profesional.findUnique`, y para cada turno calcular `precio_base` (precio del servicio + sus extras, el mismo criterio que usa `armarDesglose` en `lib/pagos.js`) y los dos campos de comisión con `resolverComision`.

`profesional_id` va en `base`, que lo comparten todos los turnos de la reserva. `precio_base` y la comisión son **por turno**, porque cada uno tiene su propio servicio y sus propios extras.

- [ ] **Step 6: Mapear el error nuevo a HTTP**

En `responderErrorReserva` (`routes/pagos.js:12`) y donde `routes/turnos.js` mapea los errores de reserva, agregar:

```
SERVICIOS_DE_DISTINTAS_PROFESIONALES -> 400
"No se pueden combinar servicios de distintas profesionales en una misma reserva"
```

- [ ] **Step 7: Resincronizar al cambiar el servicio de un turno** *(Review Focus 2)*

`PATCH /api/turnos/:id` acepta `nuevo_servicio_id` (`routes/turnos.js:511`) y `routes/admin.js:296` hace lo mismo. Hoy actualizan `servicio_id` sin tocar nada más, así que el turno quedaría con la profesional y la comisión del servicio viejo.

En los dos lugares, cuando cambia el servicio: recalcular `profesional_id`, `precio_base`, `comision_pct` y `comision_monto` a partir del servicio nuevo, en el mismo `data` del update.

Verificación manual: editar un turno de Daniela cambiándole el servicio a uno de Elsa; el turno tiene que terminar con `profesional_id = 2` y comisión cargada.

- [ ] **Step 8: Verificar el guard de punta a punta**

| Prueba | Esperado |
|---|---|
| `POST /api/turnos/multi` con un servicio de cada profesional | 400 con el mensaje de arriba |
| `POST /api/turnos` de un servicio de Elsa | se crea con `profesional_id = 2` y los tres campos de plata cargados |
| `POST /api/turnos` de un servicio de Daniela | se crea con `profesional_id = 1`, `comision_pct` y `comision_monto` en `null` |

- [ ] **Step 9: Commit**

```bash
git add lib/reservas.js routes/turnos.js routes/admin.js routes/pagos.js test/reservas.test.js
git commit -m "feat(reservas): profesional unica por reserva y comision congelada"
```

---

## Task 6: Pagos — holds con profesional y exclusión del cobro online

**Files:**
- Modify: `lib/availability.js:17,34,59` (filtros de hold)
- Modify: `routes/pagos.js:50-217` (checkout setea el hold)
- Modify: `lib/pagos.js:115-168` (`calcularMonto`)

**Interfaces:**
- Consumes: `profesionalId` del retorno de `construirTurnosDeReserva` (Task 5)
- Produces: nada nuevo hacia otras tareas

- [ ] **Step 1: Filtrar los holds por profesional**

En `whereHoldsActivos`, `holdsActivosComoTurnos` y `hayHoldEnConflicto`, agregar `OR: [{ profesional_id: null }, { profesional_id: profesionalId }]`. Las tres suman el parámetro y los llamadores se lo pasan.

El `null` queda como comportamiento defensivo para filas viejas, no como caso normal (§5.5).

- [ ] **Step 2: Setear `profesional_id` al crear el hold**

En `/api/pagos/checkout`, al crear la `ReservaPendiente`, pasar el `profesionalId` que ya devuelve `construirTurnosDeReserva`. Sin esto, un pago en curso de una clienta de Daniela congela la agenda de Elsa.

- [ ] **Step 3: Excluir del cobro online a las profesionales con comisión**

En `calcularMonto` (`lib/pagos.js:115`), después de resolver los servicios y antes de aplicar la lógica de seña: si la profesional de la reserva tiene `comision_pct_default != null`, devolver

```js
{ requiere_pago: false, motivo: 'profesional_sin_cobro_online' }
```

Va **antes** del chequeo de `config.cobro_activo`, para que la respuesta sea la misma esté el cobro prendido o apagado.

- [ ] **Step 4: Verificar**

| Prueba | Esperado |
|---|---|
| `POST /api/pagos/cotizar` con un servicio de Elsa (con `comision_pct_default` cargado) | `requiere_pago: false`, `motivo: 'profesional_sin_cobro_online'` |
| `POST /api/pagos/cotizar` con un servicio de Daniela | la respuesta de hoy (`cobro_desactivado` mientras `cobro_activo = false`) |
| Hold activo de Daniela 15:00 → disponibilidad de Elsa 15:00 | **aparece libre** |

El tercero es el que importa y hay que forzarlo a mano: prender `cobro_activo`, arrancar un checkout de Daniela sin pagarlo, y consultar la agenda de Elsa antes de que expire el hold. Volver a apagar `cobro_activo` al terminar.

- [ ] **Step 5: Commit**

```bash
git add lib/availability.js lib/pagos.js routes/pagos.js
git commit -m "feat(pagos): holds por profesional y exclusion del cobro online"
```

---

## Task 7: API de profesionales y servicios

**Files:**
- Create: `routes/profesionales.js`
- Modify: `routes/servicios.js`
- Modify: `server.js`

**Interfaces:**
- Produces: `GET/POST/PATCH/DELETE /api/profesionales`. `GET /api/servicios` devuelve `profesional_id` y el objeto `profesional` anidado (`{ id, nombre }`). Tasks 10, 11 y 13 consumen esto.

- [ ] **Step 1: CRUD de profesionales en `routes/profesionales.js`**

Siguiendo el patrón de `routes/servicios.js`: `GET /` público (solo activas, ordenadas por `orden` y `nombre`), y `POST`, `PATCH /:id`, `DELETE /:id` con `authAdmin`. El `DELETE` desactiva (`activo = false`), no borra.

- [ ] **Step 2: Validar `comision_pct_default`** *(Review Focus 3)*

En `POST` y `PATCH`: si viene y no es `null`, tiene que ser un número entre 0 y 100. Si no, `400` con `"La comisión debe estar entre 0 y 100"`. La misma validación va en `routes/servicios.js` para `comision_pct`.

Sin esto, Daniela tipea `300` y la liquidación le pide a Elsa el triple de lo facturado.

- [ ] **Step 3: Montar la ruta en `server.js`**

```js
app.use('/api/profesionales', require('./routes/profesionales'));
```

- [ ] **Step 4: Arreglar el POST de servicios y agregar los campos nuevos**

`routes/servicios.js:22` destructura solo cinco campos y descarta el resto del body. Hay que aceptar también `profesional_id` (obligatorio: `400` si falta), `comision_pct`, `intercalable`, `intercalar_desde_min`, `servicios_compatibles` y `max_simultaneos`.

Los cuatro últimos no son alcance de este spec, pero hoy se pierden al crear un servicio y el panel ya los manda: dejarlos afuera mantiene vivo un bug conocido en la misma línea que se está editando.

En el `PATCH`, reemplazar `data: req.body` por una lista explícita de campos permitidos. Hoy cualquier columna es escribible desde el body.

- [ ] **Step 5: Excluir los servicios de profesionales inactivas** *(Review Focus 1)*

`GET /api/servicios` filtra por `activo: true` del servicio. Agregar `profesional: { activo: true }` al `where`, e `include: { profesional: { select: { id: true, nombre: true } } }`.

Sin esto, Daniela desactiva a Elsa y sus 7 servicios siguen tomando turnos.

- [ ] **Step 6: Verificar**

| Prueba | Esperado |
|---|---|
| `GET /api/servicios` | cada servicio trae `profesional: { id, nombre }` |
| `POST /api/servicios` con `profesional_id: 2` e `intercalable: true` | los dos campos quedan guardados |
| `POST /api/servicios` sin `profesional_id` | 400 |
| `PATCH /api/profesionales/2` con `comision_pct_default: 300` | 400 |
| `PATCH /api/profesionales/2` con `activo: false` | los servicios de Elsa desaparecen de `GET /api/servicios` |

- [ ] **Step 7: Commit**

```bash
git add routes/profesionales.js routes/servicios.js server.js
git commit -m "feat(api): CRUD de profesionales y servicios con profesional y comision"
```

---

## Task 8: Horarios y bloqueos por profesional

**Files:**
- Modify: `routes/horarios.js`

**Interfaces:**
- Produces: `GET /api/horarios?profesional_id=N`. `POST /api/horarios` exige `profesional_id`. Los bloqueos aceptan `profesional_id` nullable.

- [ ] **Step 1: Horarios filtrados por profesional**

`GET /` acepta `?profesional_id=N` y filtra. Sin el parámetro devuelve todos, con la profesional incluida — así el panel puede mostrar las dos agendas sin dos pedidos.

`POST /` exige `profesional_id` (`400` si falta). El `PATCH` y el `DELETE` no cambian: operan por `id` de fila.

- [ ] **Step 2: Bloqueos con alcance**

`POST /bloques-cerrados` acepta `profesional_id` opcional; si no viene, queda en `null` (cierra el estudio, que es el comportamiento de hoy). `GET /bloques-cerrados` devuelve el campo y la profesional incluida cuando no es `null`.

- [ ] **Step 3: Verificar**

| Prueba | Esperado |
|---|---|
| `GET /api/horarios?profesional_id=2` | solo los rangos de Elsa |
| `POST /api/horarios` sin `profesional_id` | 400 |
| `POST /api/horarios` con `profesional_id: 2`, martes 14:00-19:00 | se crea, y los servicios de Elsa ofrecen slots ese día |
| `POST /bloques-cerrados` sin `profesional_id` | se crea con `null` y cierra las dos agendas |

- [ ] **Step 4: Commit**

```bash
git add routes/horarios.js
git commit -m "feat(api): horarios y bloqueos por profesional"
```

---

## Task 9: `liquidable` y reporte de liquidación

**Files:**
- Create: `routes/liquidacion.js`
- Modify: `routes/admin.js` (toggle de `liquidable`)
- Modify: `server.js`

**Interfaces:**
- Consumes: los campos congelados de Task 5
- Produces: `GET /api/admin/liquidacion?profesional_id=N&desde=YYYY-MM-DD&hasta=YYYY-MM-DD` y `PATCH /api/admin/turnos/:id/liquidable`. Task 10 los consume. `GET /api/admin/turnos` pasa a incluir `profesional`, que es lo que Tasks 11 y 12 necesitan para teñir la agenda y calcular `ingresoEstudio`.

- [ ] **Step 1: Toggle de `liquidable`**

`PATCH /api/admin/turnos/:id/liquidable` con `authAdmin`, body `{ liquidable: boolean }`. Endpoint aparte del `PATCH /turnos/:id` general, que reagenda y valida disponibilidad: acá no hay nada que revalidar.

- [ ] **Step 2: El reporte en `routes/liquidacion.js`**

`GET /` con `authAdmin`. Filtros exactos de §8.2:

- `profesional_id` el pedido, `estado: 'confirmado'`, `liquidable: true`
- `fecha` entre `desde` y `hasta` inclusive
- lee `precio_base`, `comision_pct` y `comision_monto` del turno, **nunca** el precio actual del servicio

Devuelve:

```js
{
  profesional: { id, nombre, telefono },
  desde, hasta,
  turnos: [ { id, fecha, cliente_nombre, cliente_apellido, servicio_nombre,
              precio_base, comision_pct, comision_monto } ],
  totales: { facturado, comision, cantidad_turnos }
}
```

`facturado` es la suma de `precio_base`; `comision` la de `comision_monto`. El panel muestra `comision` como "a cobrarle a Elsa".

- [ ] **Step 3: Validar los parámetros** *(Review Focus 4)*

- falta `profesional_id`, `desde` o `hasta` → `400`
- fechas no parseables → `400`
- `desde` mayor que `hasta` → `400` con `"El rango de fechas está invertido"`
- `profesional_id` de una profesional con `comision_pct_default` en `null` → `400` con `"Esa profesional no tiene comisión configurada"`

Sin la primera validación, un pedido sin `hasta` devolvería el histórico completo y Daniela le cobraría a Elsa todo de una.

- [ ] **Step 4: Montar la ruta**

```js
app.use('/api/admin/liquidacion', require('./routes/liquidacion'));
```

Va después de `routes/admin.js` y `routes/pagos-admin.js`, que ya están montados en `/api/admin`.

- [ ] **Step 4b: Incluir `profesional` en `GET /api/admin/turnos`**

`routes/admin.js:89` hace `include: { servicio: true }`. Agregar `profesional: { select: { id: true, nombre: true, comision_pct_default: true } }`.

Sin esto, Tasks 11 y 12 no tienen con qué teñir la agenda ni con qué evaluar la condición de `ingresoEstudio`, y la facturación del estudio sumaría los turnos de Elsa completos.

Verificación: `GET /api/admin/turnos` devuelve `profesional` en cada turno.

- [ ] **Step 5: Verificar**

| Prueba | Esperado |
|---|---|
| Dos turnos de Elsa confirmados en el rango | los dos aparecen; `comision` es la suma |
| Uno de ellos con `liquidable: false` | no aparece ni suma |
| Un turno cancelado en el rango | no aparece |
| Subir el precio del servicio y volver a pedir el reporte | los montos **no cambian** |
| `desde` mayor que `hasta` | 400 |
| Sin `hasta` | 400, no el histórico |
| `profesional_id: 1` (Daniela, sin comisión) | 400 |

El cuarto es la razón de ser de los campos congelados.

- [ ] **Step 6: Commit**

```bash
git add routes/liquidacion.js routes/admin.js server.js
git commit -m "feat(liquidacion): reporte por profesional y toggle liquidable"
```

---

## Task 10: Panel — pestaña Equipo

Primera tarea del frontend. Código nuevo en archivo nuevo para no engordar más `page.js`, que ya tiene 1335 líneas.

**Files:**
- Create: `app/admin/EquipoTab.js`
- Modify: `app/admin/page.js`

**Interfaces:**
- Consumes: `/api/profesionales` (Task 7) y `/api/admin/liquidacion` (Task 9)
- Produces: componente `<EquipoTab token={token} />`

- [ ] **Step 1: Crear la rama del frontend**

```bash
cd ../turnos-frontend && git checkout -b feat/segunda-profesional
```

- [ ] **Step 2: Escribir `app/admin/EquipoTab.js`**

Dos bloques, con las clases que ya usa el panel (`card`, `input-field`, `btn-primary`) para que no se note el cambio de archivo:

1. **Profesionales** — lista y formularios de alta/edición: nombre, activa, orden, teléfono, comisión por defecto. Van a ser dos o tres filas: sin paginado ni búsqueda.
2. **Liquidación** — selector de profesional (solo las que tienen `comision_pct_default`), `desde` y `hasta`, y la tabla del detalle. Arriba, destacado: **"A cobrarle a {nombre}: ${comision}"**.

- [ ] **Step 3: Botón de compartir por WhatsApp**

Arma el texto del resumen (período, facturado, comisión, cantidad de turnos) y lo deja listo para mandar. Daniela lo manda con un click explícito; **no se envía nada automáticamente**. Si la profesional no tiene `telefono`, el botón queda deshabilitado con el motivo visible.

- [ ] **Step 4: Montar la pestaña en `page.js`**

Agregar `{id:'equipo',label:'👥 Equipo'}` al array de pestañas (`app/admin/page.js:486`) y `{tab === 'equipo' && <EquipoTab token={token} />}` entre los bloques de pestañas.

- [ ] **Step 5: Verificar en el navegador**

Crear una profesional, editarla, desactivarla. Cargarle a Elsa su `comision_pct_default` y su teléfono. Pedir una liquidación de un mes con turnos y comprobar que el total coincide con lo que devuelve la API.

- [ ] **Step 6: Commit**

```bash
git add app/admin/EquipoTab.js app/admin/page.js
git commit -m "feat(panel): pestana Equipo con profesionales y liquidacion"
```

---

## Task 11: Panel — servicios, horarios, bloqueos y agenda

**Files:**
- Modify: `app/admin/page.js`

**Interfaces:**
- Consumes: las APIs de Tasks 7, 8 y 9

- [ ] **Step 1: Servicios**

Selector de profesional en alta y edición (`:661-790`). Campo de comisión visible solo si la profesional elegida tiene `comision_pct_default != null`. Lista agrupada por profesional.

Arreglar también el `setNuevoServicio` del reset en `:244`, que hoy pierde los campos de intercalación del estado.

- [ ] **Step 2: Horarios**

Dos pastillas arriba de la pestaña (`:879`) que filtran la vista entera y determinan el `profesional_id` del alta. La grilla de días no cambia.

- [ ] **Step 3: Bloqueos**

Selector de alcance en el alta (`:911`): *Todo el estudio* (`null`), *Solo Daniela*, *Solo Elsa*. Cada fila de la lista muestra a quién afecta.

- [ ] **Step 4: Agenda**

En la pestaña Turnos (`:492-660`):

- nombre de la profesional en la tarjeta del turno (`:448`)
- `colorServicioCal` (`:424`) pasa a teñir por `profesional_id`. Con dos agendas en paralelo, lo que hay que distinguir de un vistazo es de quién es cada columna
- filtro para ver una agenda sola
- en el alta manual: elegir profesional primero y filtrar la lista de servicios por ella, para que Daniela no pueda cargarle a Elsa un servicio ajeno
- toggle de `liquidable` en la tarjeta, llamando al endpoint de Task 9

`layoutTurnosDia` (`:428`) **no se toca**: ya asigna carriles a los turnos solapados.

- [ ] **Step 5: Verificar en el navegador**

Un turno de Elsa y uno de Daniela a la misma hora tienen que aparecer **lado a lado**, con colores distintos y el nombre de cada una. Cargar un servicio nuevo para Elsa y confirmar que queda asignado a ella y no a Daniela.

- [ ] **Step 6: Commit**

```bash
git add app/admin/page.js
git commit -m "feat(panel): profesional en servicios, horarios, bloqueos y agenda"
```

---

## Task 12: Panel — métricas

**Files:**
- Modify: `app/admin/page.js:344-370, 969-1048`

- [ ] **Step 1: Implementar `ingresoEstudio(turno)`** *(Review Focus 5)*

Fórmula exacta de §8.1:

```js
const ingresoEstudio = (t) =>
  t.profesional?.comision_pct_default == null
    ? precioTurno(t)
    : (Number(t.comision_monto) || 0);
```

El `|| 0` evita que un turno sin `comision_monto` propague un `NaN` y rompa el gráfico entero de Métricas.

- [ ] **Step 2: Reemplazar `precioTurno` por `ingresoEstudio` en el cálculo mensual**

En el `mesesMap` (`:354`). `precioTurno` sigue usándose para mostrar el precio de un turno en la agenda: lo que cambia es solo el agregado de facturación.

- [ ] **Step 3: Agregar la línea "Facturado por Elsa"**

Suma de `precioTurno` de los turnos de profesionales con comisión, mostrada aparte de la facturación del estudio. Son dos números que no se mezclan.

- [ ] **Step 4: Verificar que el histórico no se movió**

Anotar la facturación de los últimos tres meses cerrados **antes** de este cambio, y comparar después. Los turnos viejos tienen `profesional_id = 1` y Daniela no tiene comisión, así que la fórmula cae en la primera rama y devuelve lo mismo que hoy.

Expected: los tres números idénticos. Si alguno cambió, la condición de la rama está mal.

- [ ] **Step 5: Commit**

```bash
git add app/admin/page.js
git commit -m "feat(metricas): separar facturacion del estudio de la de Elsa"
```

---

## Task 13: Web pública de reservas

**Files:**
- Modify: `app/reservar/page.js`

- [ ] **Step 1: Agrupar los servicios por profesional en el STEP 1**

`:597-644`. Un encabezado por profesional con su nombre. La clienta tiene que entender que son dos personas, no dos categorías.

- [ ] **Step 2: Impedir la reserva mixta**

En cuanto elige un servicio, los de la otra profesional quedan deshabilitados, con un texto que explique por qué: *"Para combinar con un servicio de {nombre}, hacé una segunda reserva"*.

El guard del backend (Task 5) es la red de seguridad, no el mecanismo: la clienta no tiene que poder armar una reserva mixta y recibir el error al final, después de cargar sus datos.

- [ ] **Step 3: Filtrar el STEP 6 por profesional**

"Aprovechá el rato" (`:645-703`) ofrece los compatibles con el ancla elegida. Sumar al filtro de `servicios_compatibles` el de misma profesional.

- [ ] **Step 4: Verificar el flujo completo en el navegador**

| Prueba | Esperado |
|---|---|
| Elegir un servicio de Elsa | los de Daniela se deshabilitan con el texto explicativo |
| Elegir un servicio de Daniela | los de Elsa se deshabilitan |
| Reservar un servicio de Elsa un día que trabaja | aparecen los horarios de **ella** |
| Reservar un servicio de Elsa un día que no trabaja | sin horarios disponibles |
| El mismo horario con un turno de Daniela ocupado | el de Elsa **sigue disponible** |
| Pro lifting + Pies simples (las dos de Daniela) | sigue funcionando como antes |

- [ ] **Step 5: Commit**

```bash
git add app/reservar/page.js
git commit -m "feat(reservar): servicios agrupados por profesional sin reservas mixtas"
```

---

## Task 14: Cerrar la migración

Paso 4 del spec, y la pasada final del checklist. Va **después** de desplegar backend y frontend.

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Confirmar que el código nuevo está desplegado**

Backend en Railway y frontend en Vercel, los dos con los cambios de Tasks 4 a 13. Verificar creando un turno desde la web: tiene que quedar con el `profesional_id` correcto **porque el código lo setea**, no porque lo ponga el default.

- [ ] **Step 2: Quitar el `@default(1)`**

De `Servicio.profesional_id`, `HorarioConfig.profesional_id` y `Turno.profesional_id`. Quedan `Int` obligatorios, sin default.

Esto no es burocracia: con el default puesto, el día que un camino se olvide de setear `profesional_id` el turno **se le asigna a Daniela en silencio** y ensucia la liquidación. Sin default, ese bug explota con un error.

- [ ] **Step 3: Aplicar**

Run: `npx prisma db push`
Expected: sin pérdida de datos. Ninguna fila tiene `profesional_id` nulo.

- [ ] **Step 4: Correr el checklist completo de §10.2**

Los once puntos del spec, de una sentada, sobre el entorno desplegado. Es la última red antes de cargar los datos reales de Elsa.

- [ ] **Step 5: Correr los tests automáticos**

Run: `npm test`
Expected: 8 passing

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma
git commit -m "chore(profesionales): quitar el default temporal de profesional_id"
```

---

## Después del plan

Carga de datos, desde el panel y sin scripts (§9.2 del spec):

1. PRP id 16 a `activo = false`
2. Los 7 servicios de Elsa con precio, duración y comisión
3. Los días y horarios de Elsa
4. El `comision_pct_default` y el teléfono de Elsa

Fuera de alcance, para agendar aparte: los dos bugs de intercalación (`max_simultaneos` que anula la intercalación, y el `count` sin tope superior) y la limpieza de datos de prueba en producción.
