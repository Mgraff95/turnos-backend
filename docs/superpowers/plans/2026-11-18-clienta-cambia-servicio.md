# La clienta cambia el servicio de su turno — plan de implementación (Etapa B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la clienta pueda cambiarle el servicio a su turno desde `/mistura`, viendo antes qué extras conserva y cuánto le queda, sin tener que escribirle a Daniela.

**Architecture:** El `PATCH /api/turnos/:id` acepta un `nuevo_servicio_id` opcional; sin él, todo queda como hoy. Un endpoint de previsualización hace la cuenta del lado del servidor, para que el número que la clienta ve sea el mismo que se congela. La plata se recalcula entera con `plataDelTurno`, que ya existe: cambió qué se hace, así que el precio de la foto cambia con razón.

**Tech Stack:** Node + Express, Prisma 6, `node --test` (`npm test`) en el backend; Next.js 16 en el frontend, sin suite de tests (se verifica con `npm run build`, `npm run lint` contra la línea base y la checklist manual).

**Spec:** `docs/superpowers/specs/2026-11-18-editar-turno-diseno.md` (Etapa B; la Etapa A ya está en master)

## Global Constraints

- `nuevo_servicio_id` es **opcional**: sin él, el PATCH público se comporta exactamente como hoy.
- **La clienta siempre elige día y hora**, también cuando cambia el servicio (decisión 5). No hay un camino de "solo cambiar el servicio".
- **Los extras que el servicio nuevo ofrece se conservan; los demás se descartan**, y ella los ve descartados antes de confirmar (decisión 2).
- Si el turno tiene `pago_realizado`, el cambio de servicio se **rechaza** invitándola a escribir.
- El servicio nuevo tiene que estar **activo** y ser de una profesional **activa**.
- **No hay tope de precio**: puede pasar a uno más caro o más barato.
- La ventana de **24 horas** sigue valiendo igual, de los dos lados, vía `puedeModificarse`.
- Un turno de una **reserva múltiple** sigue sin poder editarse desde acá (ya lo rechaza la ruta).
- La cuenta del precio la hace **el backend**: la regla de que los extras de precio variable no suman vive en `lib/reservas.js` y no se duplica en el frontend.
- Sin migración: no se toca `schema.prisma`.

## Review Focus

1. **Turno con `pago_realizado`**: tiene que rechazar con un mensaje que la invite a escribir, no recalcular nada. → Task 1.
2. **`nuevo_servicio_id` de un servicio inactivo, o de una profesional inactiva**: rechazo claro, no un turno asignado a alguien que no atiende. → Task 1.
3. **Extras que el servicio nuevo no ofrece**: se descartan del precio, de la duración y de `extras_ids`, y aparecen como descartados en la previsualización. → Task 2.
4. **El token de otra clienta, o un token vencido, en la previsualización**: 404, sin filtrar nada del turno. → Task 2.
5. **El servicio nuevo es más largo y no entra en el hueco**: el listado no ofrece esa hora; si el pedido se arma a mano, `verificarYActualizar` lo rechaza por choque y la clienta ve "ese horario ya no está disponible". → Task 1.

De estos cinco, **el 1 y el 3 quedan cubiertos por tests** (`puedeCambiarServicio` y `cambioDeExtras` son puros). El 2, el 4 y el 5 son comportamiento de ruta, y este repo no tiene ninguna prueba a ese nivel ni `supertest`: se verifican leyendo el cuerpo contra la lista del paso correspondiente y con la checklist manual del PENDIENTE. Está dicho acá para que no parezca cubierto lo que no lo está; si en algún momento se agrega un harness de rutas, estos tres son los primeros tres tests que vale escribir.

---

### Task 1: El PATCH público acepta el servicio nuevo

**Files:**
- Modify: `lib/edicion.js` (helper puro nuevo + mensaje)
- Modify: `routes/turnos.js` — `PATCH /:id` (~:598-:690)
- Test: `test/edicion.test.js` (agregar)

**Interfaces:**
- Consumes: `plataDelTurno(servicio, profesional, extras)`, `resolverExtras(extrasInput, servicioId)`, `cargarProfesionalActiva(id)` (los tres de `lib/reservas.js`), `duracionConExtras` (ya en `lib/edicion.js`), `puedeModificarse` (`lib/fechas.js`).
- Produces:
  - `puedeCambiarServicio(turno) -> { ok: true } | { ok: false, motivo: 'PAGADO_NO_SE_CAMBIA' }` en `lib/edicion.js`.
  - `MENSAJES_EDICION.PAGADO_NO_SE_CAMBIA`, con un texto que la invite a escribir.

- [ ] **Step 1: Write the failing test**

```js
// test/edicion.test.js — agregar
const { puedeCambiarServicio } = require('../lib/edicion');

test('un turno sin pago puede cambiar de servicio', () => {
  assert.deepEqual(puedeCambiarServicio({ pago_realizado: false, pago_monto: null }), { ok: true });
});

test('un turno ya pagado no cambia de servicio desde la web', () => {
  assert.deepEqual(
    puedeCambiarServicio({ pago_realizado: true, pago_monto: 5000 }),
    { ok: false, motivo: 'PAGADO_NO_SE_CAMBIA' }
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/edicion.test.js`
Expected: FAIL — `puedeCambiarServicio is not a function`

- [ ] **Step 3: Implement `puedeCambiarServicio` y su mensaje en `lib/edicion.js`**

El texto explica por qué no se puede y qué hacer: la seña y el saldo no se recalculan solos porque hay que decidir quién pone la diferencia, y eso es una conversación. Hoy no puede pasar (`cobro_activo = false`), y es el freno que evita un bug de plata el día que se prenda.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/edicion.test.js`
Expected: PASS (11 tests en el archivo)

- [ ] **Step 5: Extender el PATCH público**

En `routes/turnos.js`, después de la guarda de `grupo_reserva` y **antes** de `puedeModificarse`:

1. `const { token, nueva_fecha, nueva_hora_inicio, nuevo_servicio_id } = req.body`.
2. Si llega `nuevo_servicio_id` y es distinto del actual:
   - `puedeCambiarServicio(turno)`; si no, `400` con `MENSAJES_EDICION[motivo]`.
   - Cargar el servicio nuevo; si no existe o `!activo`, `404`/`409` con un mensaje claro.
   - `cargarProfesionalActiva(servicioNuevo.profesional_id)`; su `PROFESIONAL_INACTIVA` (409, con `publico`) se traduce tal cual.
   - Extras: `resolverExtras(turno.extras_ids, servicioNuevo.id)` — los que el nuevo no ofrece quedan afuera.
   - `extras_ids` pasa a ser la lista de los que sobrevivieron, y la plata se recalcula **entera** con `plataDelTurno`: cambió qué se le hace, así que el precio de la foto cambia con razón (al contrario de la reasignación del panel).
3. Sin `nuevo_servicio_id`, todo sigue como hoy: mismo servicio, misma profesional, extras leídos sin filtrar por `activo`, plata intacta.
4. `hora_fin` con `duracionConExtras(servicioEfectivo, extrasEfectivos)`.
5. `verificarYActualizar` recibe el `servicio_id` y el `profesional_id` efectivos, y el `cliente: turno` que ya recibe.

- [ ] **Step 6: Verificar**

Run: `node -e "require('./routes/turnos'); console.log('ok')"`
Expected: `ok`

Run: `npm test`
Expected: PASS

Leer el cuerpo nuevo contra esta lista: un body sin `nuevo_servicio_id` arma el mismo update que hoy; un body con el mismo servicio que ya tiene no entra en ninguna de las ramas nuevas; y ningún camino manda `precio_base` si el servicio no cambió.

- [ ] **Step 7: Commit**

```bash
git add lib/edicion.js routes/turnos.js test/edicion.test.js
git commit -m "feat(turnos): la clienta puede cambiarle el servicio a su turno"
```

---

### Task 2: La previsualización del cambio

**Files:**
- Modify: `routes/turnos.js` (ruta nueva, junto al PATCH)
- Test: `test/edicion.test.js` (agregar el armado puro)

**Interfaces:**
- Consumes: `resolverExtras`, `calcularPrecioBase`, `duracionConExtras`.
- Produces:
  - `GET /api/turnos/:id/cambio-preview?token=<t>&nuevo_servicio_id=<id>` → `{ servicio: { id, nombre, duracion_minutos }, profesional: { id, nombre }, extras_conservados: [{ id, nombre, precio_pesos }], extras_descartados: [{ id, nombre }], duracion_minutos, precio }`.
  - `cambioDeExtras(extrasDelTurno, extrasQueAplican) -> { conservados, descartados }` en `lib/edicion.js`, puro: parte la lista en dos por id.

- [ ] **Step 1: Write the failing test**

```js
// test/edicion.test.js — agregar
const { cambioDeExtras } = require('../lib/edicion');

test('los extras se parten en los que siguen y los que se van', () => {
  const guardados = [{ id: 1, nombre: 'Mascarilla' }, { id: 2, nombre: 'Masaje' }];
  const aplican = [{ id: 2, nombre: 'Masaje' }];
  const r = cambioDeExtras(guardados, aplican);
  assert.deepEqual(r.conservados.map(e => e.id), [2]);
  assert.deepEqual(r.descartados.map(e => e.id), [1]);
});

test('si el servicio nuevo ofrece todos, no se descarta ninguno', () => {
  const guardados = [{ id: 1, nombre: 'Mascarilla' }];
  const r = cambioDeExtras(guardados, guardados);
  assert.deepEqual(r.descartados, []);
});

test('un turno sin extras no descarta nada', () => {
  assert.deepEqual(cambioDeExtras([], []), { conservados: [], descartados: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/edicion.test.js`
Expected: FAIL — `cambioDeExtras is not a function`

- [ ] **Step 3: Implement `cambioDeExtras` y la ruta**

La ruta valida el token igual que el PATCH (`turno.token_acceso !== token` → 404, sin distinguir "no existe" de "no es tuyo") y devuelve la cuenta usando **los mismos helpers** que el PATCH va a usar al guardar: `resolverExtras` para los que aplican, el `findMany` crudo para los guardados, `calcularPrecioBase` para el precio y `duracionConExtras` para la duración. Si los dos números no salen de los mismos helpers, la clienta confirma un precio distinto del que se congela.

- [ ] **Step 4: Verificar**

Run: `npm test -- test/edicion.test.js`
Expected: PASS

Run: `node -e "require('./routes/turnos'); console.log('ok')"`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add lib/edicion.js routes/turnos.js test/edicion.test.js
git commit -m "feat(turnos): previsualizar el cambio de servicio antes de confirmarlo"
```

---

### Task 3: Que su propio turno no le tape su horario

**Files:**
- Modify: `routes/turnos.js` — `GET /disponibilidad/:fecha/:servicio_id` (~:479)

**Interfaces:**
- Consumes: `obtenerHorariosDisponibles` con `opciones.excluirTurnoIds` (ya existe, de la Etapa A).
- Produces: el endpoint acepta `excluir_turno_id` y `token` por query; solo excluye si el token corresponde a ese turno.

- [ ] **Step 1: Agregar el par `excluir_turno_id` + `token`**

Sin esto, la clienta que quiere el **mismo día y la misma hora** con otro servicio no puede: su propio turno ocupa ese horario en el listado, así que su hora no aparece. Es el caso más común del cambio de servicio.

El `token` no es decorativo: sin él, cualquiera podría pedir el listado excluyendo un turno ajeno y ver como libre un horario que está ocupado. Se exige que `turno.token_acceso === token` y que el turno exista; si no coincide, se ignora la exclusión (no se responde error: el listado sigue siendo público y correcto).

- [ ] **Step 2: Verificar**

Run: `node -e "require('./routes/turnos'); console.log('ok')"`
Expected: `ok`

Run: `npm test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add routes/turnos.js
git commit -m "feat(turnos): al editar, el propio turno no ocupa su horario"
```

---

### Task 4: El cambio de servicio en `/mistura`

**Files:**
- Modify: `turnos-frontend/app/mistura/page.js` — estado (~:14-30), el effect de horarios (~:45-55), `abrirEdicion` (~:44), `confirmarCambio` (~:58), y el bloque del turno simple (~:298-:390)

**Interfaces:**
- Consumes: `GET /api/turnos/:id/cambio-preview` (Task 2), `GET /api/turnos/disponibilidad/:fecha/:servicio_id?excluir_turno_id=&token=` (Task 3), `PATCH /api/turnos/:id` con `nuevo_servicio_id` (Task 1), `GET /api/servicios` (ya existe, público, trae `profesional`).
- Produces: nada que consuman otras tareas.

- [ ] **Step 1: El selector de servicio**

El botón pasa de "Cambiar fecha y hora" a **"Cambiar turno"**. Adentro, un select de servicio con los activos, **con su precio y agrupados por profesional**, igual que la página de reservar; arranca en el servicio que el turno ya tiene.

- [ ] **Step 2: La previsualización**

Al elegir un servicio distinto, pedir `cambio-preview` y mostrar: la duración y el precio nuevos, quién la va a atender si cambia, y —si hay descartados— la línea de qué extras no siguen. La nota actual *"El servicio y los extras quedan igual"* se reemplaza por lo que diga la previsualización.

- [ ] **Step 3: La fecha y la hora, como hoy**

El listado de horarios pasa a pedirse para el servicio **elegido** (no el del turno) y con `excluir_turno_id` + `token`, así su hora actual aparece si sigue libre. El `confirmarCambio(hora)` manda `nuevo_servicio_id` junto con `nueva_fecha` y `nueva_hora_inicio`.

- [ ] **Step 4: Verificar**

Run: `cd ../turnos-frontend && npm run lint`
Expected: la misma cantidad de problemas que la línea base del repo (hoy 24: 15 errores, 9 warnings). Ninguno nuevo.

Run: `cd ../turnos-frontend && npm run build`
Expected: compila sin errores.

- [ ] **Step 5: Commit (en el repo del frontend)**

```bash
git add app/mistura/page.js
git commit -m "feat(mistura): la clienta puede cambiarle el servicio a su turno"
```

---

### Task 5: Los avisos y los pasos de producción

**Files:**
- Modify: `services/whatsapp.js` (`textoReasignacionEntrante`)
- Create: `docs/superpowers/PENDIENTE-clienta-cambia-servicio.md`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: nada de código nuevo.

- [ ] **Step 1: Arreglar el cierre del texto de reasignación entrante**

`textoReasignacionEntrante` cierra con *"La clienta ya tenía este turno: no hace falta avisarle nada"*. Eso es cierto cuando reasigna Daniela desde el panel, y **falso** cuando el turno cambió de profesional porque la clienta se cambió el servicio: ahí ella sí está al tanto, pero porque lo hizo ella. Reemplazar por una línea que valga en los dos casos ("La clienta ya está al tanto de este turno"), sin inventar un parámetro nuevo.

Run: `npm test -- test/avisos-textos.test.js`
Expected: PASS (el test mira que no diga "reservó" y que no filtre el teléfono; el cierre no está aserteado).

- [ ] **Step 2: Escribir el PENDIENTE**

Mismo formato que los otros. Lo que no puede faltar:

- **Backend primero, frontend después**, por la misma razón que la Etapa A: `/mistura` le pega a dos endpoints nuevos.
- Sin migración.
- Checklist: cambiar el servicio por uno más caro de la misma profesional; cambiarlo por uno de la otra profesional (el turno pasa a su agenda y las dos profesionales reciben el aviso de reasignación); cambiarlo conservando el mismo día y hora (tiene que ofrecerle su hora actual); un turno con un extra que el servicio nuevo no ofrece (lo ve descartado antes de confirmar); y un turno a menos de 24 horas (no se puede, con el mensaje de siempre).
- Lo que queda afuera: el tope de precio (no hay), el cambio de servicio de una reserva múltiple (sigue siendo cancelar y reservar), y la validación del horario de trabajo en el motor.

- [ ] **Step 3: Commit**

```bash
git add services/whatsapp.js docs/superpowers/PENDIENTE-clienta-cambia-servicio.md
git commit -m "docs: pasos para poner el cambio de servicio en produccion"
```
