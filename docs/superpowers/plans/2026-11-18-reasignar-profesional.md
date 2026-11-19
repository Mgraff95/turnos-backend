# Reasignar profesional desde el panel — plan de implementación (Etapa A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que Daniela pueda cambiarle la profesional a un turno sin tocar el día, la hora ni el servicio, con la plata congelada recalculada y sin que la clienta reciba nada.

**Architecture:** El `PATCH /api/admin/turnos/:id` acepta un `profesional_id` opcional; sin él, todo sigue derivándose del servicio como hoy. Las decisiones que hoy están inline en la ruta (qué cambió, si se puede reasignar, si hay que recongelar la plata) se mueven a `lib/edicion.js`, puro y testeable, porque es donde viven los bugs. El cálculo de la plata queda en un solo lugar (`plataDelTurno`), que el camino de alta también pasa a usar.

**Tech Stack:** Node + Express, Prisma 6, `node --test` (`npm test`) en el backend; Next.js 16 en el frontend, sin suite de tests (se verifica con `npm run build` y la checklist manual).

**Spec:** `docs/superpowers/specs/2026-11-18-editar-turno-diseno.md` (Etapa A; la Etapa B va en un plan aparte)

## Global Constraints

- `profesional_id` en el PATCH es **opcional**: sin él, el comportamiento es el de hoy.
- Una profesional **inactiva** nunca puede quedar asignada a un turno.
- **Un turno con `grupo_reserva` no se puede reasignar**; el resto de su edición sigue abierta.
- **La comisión del turno reasignado sale del `comision_pct_default` de la profesional nueva.** El `comision_pct` del servicio se ignora cuando la profesional del turno no es la dueña del servicio.
- **La plata se recalcula solo si cambió el servicio o la profesional.** En cualquier otra edición, los campos congelados no se tocan.
- Cambiar **solo** la profesional **no** le manda ningún mensaje a la clienta.
- Los avisos siguen siendo *fire and forget* con `.catch()` que loguea, y van con `SOLO_LA_PROFESIONAL` (`incluirEstudio: false`).
- Sin migración: no se toca `schema.prisma`.
- El panel no tiene límite de antelación: el endpoint nuevo de disponibilidad va siempre con `respetarAntelacion: false`.

## Review Focus

Pinchazos que el diseño implica y hay que testear:

1. **Servicio con `comision_pct: 0` reasignado a una profesional con comisión**: el 0 es del acuerdo con su dueña; si se hereda, la profesional nueva cobra y el estudio no recibe nada. → Task 1.
2. **Servicio con `comision_pct` reasignado a Daniela** (`comision_pct_default: null`): tiene que quedar sin comisión, o la plata queda congelada en una liquidación que `routes/liquidacion.js` nunca muestra. → Task 1.
3. **Edición que no toca ni servicio ni profesional** (corregir un apellido): los campos congelados tienen que quedar **idénticos**. Hoy se recalculan. → Task 2.
4. **Turno con extras con `minutos_adicionales` al editarlo**: el `hora_fin` tiene que incluirlos, o el turno queda más corto de lo que dura y se ofrece tiempo ocupado. → Task 2 (`duracionConExtras`), usada en Task 3.
5. **Reasignar una pata de una reserva múltiple**: tiene que fallar con un mensaje propio, no partir el bloque entre dos agendas. → Task 2.

---

### Task 1: La plata del turno, en un solo lugar

**Files:**
- Modify: `lib/comisiones.js`
- Modify: `lib/reservas.js` (`resolverProfesionalYPlata`, ~:90-120; exports)
- Test: `test/comisiones.test.js` (agregar), `test/plata-del-turno.test.js` (nuevo)

**Interfaces:**
- Consumes: `calcularPrecioBase(servicio, extras)` y `resolverComision(servicio, profesional, precioBase)`, que ya existen.
- Produces:
  - `resolverComisionDeTurno(servicio, profesional, precioBase) -> { comision_pct, comision_monto }` en `lib/comisiones.js`. Si `servicio.profesional_id !== profesional.id`, el pct es **solo** `profesional.comision_pct_default`; si coinciden, delega en `resolverComision` (comportamiento actual).
  - `plataDelTurno(servicio, profesional, extras) -> { precio_base, comision_pct, comision_monto }` en `lib/reservas.js`.
  - `resolverProfesionalYPlata` pasa a usar `plataDelTurno` por dentro, sin cambiar su firma ni su resultado.

- [ ] **Step 1: Write the failing test**

```js
// test/comisiones.test.js — agregar al final
const { resolverComisionDeTurno } = require('../lib/comisiones');

const prpDeNoemi = { profesional_id: 2, precio_pesos: 70000, comision_pct: null };
const noemi = { id: 2, comision_pct_default: 50 };
const daniela = { id: 1, comision_pct_default: null };

test('el turno de su propia profesional se calcula como siempre', () => {
  assert.deepEqual(resolverComisionDeTurno(prpDeNoemi, noemi, 70000), { comision_pct: 50, comision_monto: 35000 });
});

test('reasignado a la dueña del estudio, no hay nada que liquidar', () => {
  assert.deepEqual(resolverComisionDeTurno(prpDeNoemi, daniela, 70000), { comision_pct: null, comision_monto: null });
});

test('el 0% del servicio no se hereda al reasignarlo: era el acuerdo con su dueña', () => {
  const servicioDeDaniela = { profesional_id: 1, precio_pesos: 35000, comision_pct: 0 };
  assert.deepEqual(resolverComisionDeTurno(servicioDeDaniela, noemi, 35000), { comision_pct: 50, comision_monto: 17500 });
});

test('el % propio del servicio sigue mandando mientras lo atienda su dueña', () => {
  const conExcepcion = { profesional_id: 2, precio_pesos: 70000, comision_pct: 30 };
  assert.deepEqual(resolverComisionDeTurno(conExcepcion, noemi, 70000), { comision_pct: 30, comision_monto: 21000 });
});
```

```js
// test/plata-del-turno.test.js — nuevo
const test = require('node:test');
const assert = require('node:assert/strict');
const { plataDelTurno } = require('../lib/reservas');

const prpDeNoemi = { id: 7, profesional_id: 2, precio_pesos: 70000, comision_pct: null };
const noemi = { id: 2, comision_pct_default: 50 };

test('la plata del turno junta precio con extras y comision', () => {
  const extras = [{ precio_pesos: 5000, precio_variable: false }];
  assert.deepEqual(plataDelTurno(prpDeNoemi, noemi, extras), {
    precio_base: 75000, comision_pct: 50, comision_monto: 37500
  });
});

test('un extra de precio variable no suma al precio congelado', () => {
  const extras = [{ precio_pesos: 9999, precio_variable: true }];
  assert.equal(plataDelTurno(prpDeNoemi, noemi, extras).precio_base, 70000);
});

test('sin extras es el precio del servicio', () => {
  assert.equal(plataDelTurno(prpDeNoemi, noemi, []).precio_base, 70000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/comisiones.test.js test/plata-del-turno.test.js`
Expected: FAIL — `resolverComisionDeTurno is not a function` / `plataDelTurno is not a function`

- [ ] **Step 3: Implement las dos funciones**

`resolverComisionDeTurno` en `lib/comisiones.js`, exportada; `plataDelTurno` en `lib/reservas.js`, exportada. Ambas puras.

- [ ] **Step 4: Hacer que `resolverProfesionalYPlata` use `plataDelTurno`**

Reemplazar el `calcularPrecioBase` + `resolverComision` que hoy tiene inline en el `for` (~`lib/reservas.js:112-118`). El resultado tiene que ser idéntico: en ese camino la profesional siempre es la dueña de los servicios, así que la rama nueva no se activa.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, incluidos los tests viejos de comisiones y reservas (son la red de que el camino de alta no cambió).

- [ ] **Step 6: Commit**

```bash
git add lib/comisiones.js lib/reservas.js test/comisiones.test.js test/plata-del-turno.test.js
git commit -m "feat(plata): la comision de un turno reasignado es la de quien lo atiende"
```

---

### Task 2: Qué cambió y qué se puede reasignar

**Files:**
- Create: `lib/edicion.js`
- Test: `test/edicion.test.js`

**Interfaces:**
- Consumes: nada.
- Produces, puros:
  - `cambiosDeTurno(turnoActual, datos) -> { servicio, fecha, hora, profesional, recalcularPlata, avisarClienta, avisarProfesionales }`, todos booleanos. `datos` trae `{ servicio_id, profesional_id, fecha, hora_inicio }` ya normalizados (números y `'YYYY-MM-DD'`). `recalcularPlata = servicio || profesional`. `avisarClienta = servicio || fecha || hora` (lo de hoy). `avisarProfesionales = servicio || fecha || hora || profesional`.
  - `puedeReasignar(turnoActual, profesionalIdNuevo) -> { ok: true } | { ok: false, motivo: 'BLOQUE_NO_SE_REASIGNA' }`.
  - `MENSAJES_EDICION = { BLOQUE_NO_SE_REASIGNA: '<texto>' }`.
  - `duracionConExtras(servicio, extras) -> number` — los minutos del servicio más los `minutos_adicionales` de cada extra. Existe porque los dos PATCH hoy no los suman y los cinco caminos de alta sí; sacarla acá la hace testeable sin tocar las rutas.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { cambiosDeTurno, puedeReasignar, duracionConExtras } = require('../lib/edicion');

const turno = {
  servicio_id: 7, profesional_id: 2, hora_inicio: '15:00',
  fecha: new Date('2026-11-18T00:00:00.000Z'), grupo_reserva: null
};
const igual = { servicio_id: 7, profesional_id: 2, fecha: '2026-11-18', hora_inicio: '15:00' };

test('corregir un apellido no recalcula la plata ni avisa a nadie', () => {
  const c = cambiosDeTurno(turno, igual);
  assert.equal(c.recalcularPlata, false);
  assert.equal(c.avisarClienta, false);
  assert.equal(c.avisarProfesionales, false);
});

test('cambiar solo la profesional recalcula la plata y avisa a las profesionales, no a la clienta', () => {
  const c = cambiosDeTurno(turno, { ...igual, profesional_id: 1 });
  assert.equal(c.profesional, true);
  assert.equal(c.recalcularPlata, true);
  assert.equal(c.avisarProfesionales, true);
  assert.equal(c.avisarClienta, false);
});

test('mover la hora avisa a la clienta y no recalcula la plata', () => {
  const c = cambiosDeTurno(turno, { ...igual, hora_inicio: '17:00' });
  assert.equal(c.hora, true);
  assert.equal(c.avisarClienta, true);
  assert.equal(c.recalcularPlata, false);
});

test('cambiar el servicio recalcula la plata y avisa a todos', () => {
  const c = cambiosDeTurno(turno, { ...igual, servicio_id: 9 });
  assert.equal(c.recalcularPlata, true);
  assert.equal(c.avisarClienta, true);
  assert.equal(c.avisarProfesionales, true);
});

test('la fecha se compara por dia, no por objeto', () => {
  assert.equal(cambiosDeTurno(turno, { ...igual, fecha: '2026-11-18' }).fecha, false);
  assert.equal(cambiosDeTurno(turno, { ...igual, fecha: '2026-11-19' }).fecha, true);
});

test('la duracion suma los minutos de los extras', () => {
  const servicio = { duracion_minutos: 60 };
  assert.equal(duracionConExtras(servicio, [{ minutos_adicionales: 15 }, { minutos_adicionales: 10 }]), 85);
  assert.equal(duracionConExtras(servicio, [{ precio_pesos: 5000 }]), 60);
  assert.equal(duracionConExtras(servicio, []), 60);
  assert.equal(duracionConExtras(servicio, undefined), 60);
});

test('un turno suelto se puede reasignar', () => {
  assert.deepEqual(puedeReasignar(turno, 1), { ok: true });
});

test('una pata de una reserva multiple no se reasigna', () => {
  const enBloque = { ...turno, grupo_reserva: 'g1' };
  assert.deepEqual(puedeReasignar(enBloque, 1), { ok: false, motivo: 'BLOQUE_NO_SE_REASIGNA' });
});

test('editar un turno de un bloque sin cambiarle la profesional se permite', () => {
  const enBloque = { ...turno, grupo_reserva: 'g1' };
  assert.deepEqual(puedeReasignar(enBloque, 2), { ok: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/edicion.test.js`
Expected: FAIL — `Cannot find module '../lib/edicion'`

- [ ] **Step 3: Implement `lib/edicion.js`**

Las dos funciones y el mapa de mensajes. La fecha del turno viene como `Date` de Prisma (columna `@db.Date`) y la nueva como `'YYYY-MM-DD'`: comparar los dos como string de día, con el mismo `toISOString().split('T')[0]` que usa el resto del repo.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/edicion.test.js`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/edicion.js test/edicion.test.js
git commit -m "feat(edicion): que cambio en el turno y si se puede reasignar"
```

---

### Task 3: El PATCH del panel acepta la profesional

**Files:**
- Modify: `routes/admin.js` — `PATCH /turnos/:id` (:338-:445)
- Modify: `lib/reservas.js` — extraer `cargarProfesionalActiva` de `resolverProfesionalYPlata` (~:94-108)

**Interfaces:**
- Consumes: `plataDelTurno` (Task 1), `cambiosDeTurno`, `puedeReasignar`, `MENSAJES_EDICION` (Task 2), `resolverExtras` (ya existe).
- Produces: `cargarProfesionalActiva(id) -> Promise<Profesional>` en `lib/reservas.js`, que tira `PROFESIONAL_NO_ENCONTRADA` (404) o `PROFESIONAL_INACTIVA` (409, con `publico`). `resolverProfesionalYPlata` la usa por dentro.

- [ ] **Step 1: Extraer `cargarProfesionalActiva` y verificar que no cambió nada**

Mover el `findUnique` + los dos `throw` de `resolverProfesionalYPlata` a la función nueva, y llamarla desde ahí.

Run: `npm test`
Expected: PASS — los tests de reservas cubren los dos throws.

- [ ] **Step 2: Reescribir el cuerpo del PATCH**

En este orden, que importa:

1. `const { ..., profesional_id } = req.body` — opcional.
2. El `findUnique` de `turnoActual` ya trae `include: { servicio: true }`; agregarle que traiga `grupo_reserva` (es escalar, ya viene).
3. Si llega `profesional_id`: `puedeReasignar(turnoActual, parseInt(profesional_id))`; si no, `400` con `MENSAJES_EDICION[motivo]`.
4. Resolver la profesional: si llega `profesional_id`, `cargarProfesionalActiva(profesional_id)`; si no, la dueña del servicio (como hoy, vía `resolverProfesionalYPlata`).
5. Los extras con **`resolverExtras(turnoActual.extras_ids, servicioIdNuevo)`**, que filtra por `servicios_ids` y por `activo` — hoy es un `findMany` crudo que conserva extras que el servicio nuevo no ofrece.
6. `horaFin` con **`duracionConExtras(servicio, extras)`**, como los caminos de alta — hoy el PATCH ignora los minutos de los extras.
7. `cambiosDeTurno(turnoActual, { servicio_id, profesional_id: profesionalResuelta.id, fecha, hora_inicio })`.
8. La plata: **solo si `cambios.recalcularPlata`**, con `plataDelTurno(servicio, profesionalResuelta, extras)`. Si no, no mandar ninguno de los tres campos en el update.
9. El mensaje a la clienta queda igual, condicionado a `cambios.avisarClienta`.
10. `avisarModificacion(turnoActual, turno, SOLO_LA_PROFESIONAL)` **fuera** de ese `if`, condicionado a `cambios.avisarProfesionales`.
11. El `catch` de `HORARIO_NO_DISPONIBLE` devuelve `Ese horario ya está ocupado para ${profesionalResuelta.nombre}` en vez del genérico.

- [ ] **Step 3: Verificar que el módulo carga y la suite sigue verde**

Run: `node -e "require('./routes/admin'); console.log('ok')"`
Expected: `ok`

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Verificar a mano los tres caminos del PATCH**

Sin servidor local no hay forma de ejercitar la ruta, así que la verificación es leer el cuerpo nuevo contra esta lista:
- un body sin `profesional_id` arma exactamente el mismo update que antes del cambio, salvo `hora_fin` (ahora con extras) y la plata (ahora condicional);
- un body con `profesional_id` igual al actual no entra en `recalcularPlata` por la profesional;
- ningún camino manda `precio_base`/`comision_pct`/`comision_monto` cuando `recalcularPlata` es `false`.

- [ ] **Step 5: Commit**

```bash
git add routes/admin.js lib/reservas.js
git commit -m "feat(panel): reasignar la profesional de un turno sin tocar el resto"
```

---

### Task 4: Disponibilidad de una profesional explícita

**Files:**
- Modify: `routes/admin.js` (ruta nueva, junto a las otras de turnos)

**Interfaces:**
- Consumes: `obtenerHorariosDisponibles(fecha, duracionMinutos, servicioId, profesionalId, opciones)` y `resolverExtras`, que ya existen.
- Produces: `GET /api/admin/disponibilidad/:fecha/:servicio_id/:profesional_id?extras=1,2` con `authAdmin`, que responde `{ fecha, servicio, profesional, horarios }`.

- [ ] **Step 1: Escribir la ruta**

Modelada sobre `routes/turnos.js:479` (el endpoint público), con tres diferencias: va con `authAdmin`, la profesional sale del parámetro y no del servicio, y `respetarAntelacion` es **siempre `false`** (el panel no tiene límite). `usaCamilla` sale de `servicio.usa_camilla`, igual que el público. Un servicio inactivo o una profesional inactiva devuelven `horarios: []`, como hace el público.

Va bajo `authAdmin` y no como un parámetro del endpoint público a propósito: ese endpoint no tiene auth, y dejar elegir la profesional ahí permitiría a cualquiera cruzar las agendas del estudio.

- [ ] **Step 2: Verificar que el módulo carga**

Run: `node -e "require('./routes/admin'); console.log('ok')"`
Expected: `ok`

Run: `npm test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add routes/admin.js
git commit -m "feat(panel): disponibilidad de una profesional explicita"
```

---

### Task 5: Los avisos de reasignación

**Files:**
- Modify: `services/whatsapp.js` (dos textos nuevos)
- Modify: `lib/avisos.js` (`avisarModificacion`, la rama de cambio de profesional)
- Test: `test/avisos-textos.test.js` (agregar), `test/avisos-envio.test.js` (agregar)

**Interfaces:**
- Consumes: `destinatarios`, `mandar`, `enviarTodos` (ya existen en `lib/avisos.js`).
- Produces, en `services/whatsapp.js`:
  - `textoReasignacionSaliente(turno, { profesionalNueva }) -> string` — para la que pierde el turno.
  - `textoReasignacionEntrante(turno, { profesionalAnterior }) -> string` — para la que lo gana.

  `avisarModificacion`, cuando `turnoAnterior.profesional_id !== turnoNuevo.profesional_id`, usa estos dos en lugar de `textoCancelacion` / `textoNuevoTurno`.

- [ ] **Step 1: Write the failing tests**

```js
// test/avisos-textos.test.js — agregar
const { textoReasignacionSaliente, textoReasignacionEntrante } = require('../services/whatsapp');

test('a la que pierde el turno se le dice a quien pasa, no que se cancelo', () => {
  const t = textoReasignacionSaliente(turno, { profesionalNueva: 'Daniela' });
  assert.match(t, /Daniela/);
  assert.match(t, /PRP/);
  assert.doesNotMatch(t, /cancel/i);
  assert.doesNotMatch(t, /quedó libre/i);
  assert.doesNotMatch(t, /1123456789/);
});

test('a la que lo gana se le dice que se lo pasaron, no que es una reserva nueva', () => {
  const t = textoReasignacionEntrante(turno, { profesionalAnterior: 'Noemí' });
  assert.match(t, /Noemí/);
  assert.match(t, /15:00/);
  assert.doesNotMatch(t, /reservó/i);
  assert.doesNotMatch(t, /1123456789/);
});
```

```js
// test/avisos-envio.test.js — agregar
test('al reasignar, cada una recibe el texto de reasignacion y no cancelacion+alta', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  const anterior = { ...turno, profesional_id: 2 };
  const nuevo = { ...turno, profesional_id: 3 };
  const porId = { 2: { nombre: 'Noemí', telefono: '1198765432' }, 3: { nombre: 'Flor', telefono: '1177778888' } };
  await avisarModificacion(anterior, nuevo, {
    incluirEstudio: false,
    deps: {
      prisma: { profesional: { findUnique: async ({ where }) => porId[where.id] } },
      enviar: async (telefono, mensaje) => { enviados.push({ telefono, mensaje }); return true; }
    }
  });
  const porTelefono = Object.fromEntries(enviados.map(e => [e.telefono, e.mensaje]));
  assert.match(porTelefono['1198765432'], /Flor/);
  assert.doesNotMatch(porTelefono['1198765432'], /cancel/i);
  assert.match(porTelefono['1177778888'], /Noemí/);
});
```

El test viejo `si cambia la profesional, una se entera de la baja y la otra del alta` espera `/cancel/i` en el mensaje de la que pierde: hay que **actualizarlo** en este mismo paso para que espere el texto de reasignación. Es el mismo comportamiento contado mejor, no una regresión.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/avisos-textos.test.js test/avisos-envio.test.js`
Expected: FAIL — `textoReasignacionSaliente is not a function`

- [ ] **Step 3: Implement los dos textos y la rama de `avisarModificacion`**

Los textos en el tono de los otros avisos a la profesional: segunda persona, sin el teléfono de la clienta, con fecha, hora, servicio y nombre de la clienta. `avisarModificacion` ya resuelve las dos profesionales; lo único que cambia es qué texto le pasa a cada una y que ahora cada texto necesita el nombre de la otra.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/whatsapp.js lib/avisos.js test/avisos-textos.test.js test/avisos-envio.test.js
git commit -m "feat(avisos): texto propio para un turno reasignado"
```

---

### Task 6: El selector de profesional en el panel

**Files:**
- Modify: `turnos-frontend/app/admin/page.js` — `handleAbrirEdicion` (:379), `handleEditarTurno` (:383-:390), el effect de horarios (:122), `opcionesHoraEdit` (:481-:489), el formulario de edición (:583-:592)

**Interfaces:**
- Consumes: `GET /api/admin/disponibilidad/:fecha/:servicio_id/:profesional_id` (Task 4), `PATCH /api/admin/turnos/:id` con `profesional_id` (Task 3), `profesionales` (ya está en el estado).
- Produces: nada que consuman otras tareas.

- [ ] **Step 1: Llevar la profesional en el estado de la edición**

`handleAbrirEdicion` agrega `profesional_id: String(turno.profesional_id)` y `extras_ids: turno.extras_ids || []` a `editandoTurno`, y `handleEditarTurno` manda `profesional_id` en el PATCH.

- [ ] **Step 2: Borrar el filtro muerto del select de Servicio**

En el `<select>` de Servicio (:588), el filtro es hoy
`s.activo && (!editandoTurno.profesional_id || s.profesional_id === editandoTurno.profesional_id)`.
Como `editandoTurno` nunca tenía `profesional_id`, la segunda parte nunca corría; con el Step 1 empezaría a correr y reduciría el select a los servicios de esa profesional, que es **lo contrario** del objetivo. Dejar solo `s.activo`.

- [ ] **Step 3: Agregar el select de Profesional**

Arriba del de Servicio, con las profesionales **activas** (`profesionales.filter(p => p.activo)`), arrancando en la del turno. Al lado del nombre del servicio elegido, cuando `servicio.profesional_id !== editandoTurno.profesional_id`, un `(servicio de <dueña>)`.

- [ ] **Step 4: Pedir los horarios de la profesional elegida**

El effect de :122 pasa a llamar al endpoint nuevo con `editandoTurno.profesional_id` y `extras=` con los `extras_ids`, y a depender también de `editandoTurno.profesional_id`.

`opcionesHoraEdit` (:481) **no se toca**: su `mismoContexto` mira fecha y servicio, no la profesional, así que la hora original se sigue ofreciendo cuando solo se reasigna. Eso es lo que hace que reasignar sin mover el horario sea posible aunque el servicio use la camilla —el turno que se está moviendo ocupa la camilla y por eso su propia hora no aparece en el listado de la otra agenda—, y el backend lo acepta porque `verificarYActualizar` se excluye a sí mismo.

- [ ] **Step 5: El cartel del mes anterior**

Si la fecha del turno es de un mes calendario anterior al actual, mostrar dentro del formulario: que reasignarlo cambia una liquidación que quizá ya se compartió. Es un aviso, no un bloqueo (decisión 6 del diseño).

- [ ] **Step 6: Verificar**

Run: `cd ../turnos-frontend && npm run build`
Expected: compila sin errores.

Run: `cd ../turnos-frontend && npm run lint`
Expected: sin errores nuevos.

- [ ] **Step 7: Commit (en el repo del frontend)**

```bash
git add app/admin/page.js
git commit -m "feat(panel): elegir la profesional al editar un turno"
```

---

### Task 7: Los pasos de producción

**Files:**
- Create: `docs/superpowers/PENDIENTE-reasignar-profesional.md`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: nada de código.

- [ ] **Step 1: Escribir el PENDIENTE**

Mismo formato que los otros dos. Lo que no puede faltar:

- **El orden del deploy importa, y al revés de lo que uno haría.** El frontend se despliega **solo** al mergear a master, y le pega a un endpoint que todavía no existe. Entonces: backend primero (push + deploy en Railway), **recién después** mergear el frontend a master. Si se hace al revés, el formulario de edición del panel queda sin horarios hasta que el backend salga.
- Sin migración: no se toca el schema.
- Checklist de prueba: reasignar un turno de Noemí a Daniela sin tocar día ni hora (la clienta no recibe nada; las dos profesionales sí, con el texto de reasignación); intentar reasignar una pata de una reserva múltiple (rechazo con mensaje); reasignar a una hora en que la otra ya tiene algo (bloqueo nombrándola); editar solo el apellido de una clienta y verificar en la pestaña Equipo que la liquidación del período **no cambió**; editar un turno con extras y comprobar que el `hora_fin` los incluye.
- Lo que queda afuera: la validación del horario de trabajo en el motor, y la Etapa B.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/PENDIENTE-reasignar-profesional.md
git commit -m "docs: pasos para poner la reasignacion en produccion"
```
