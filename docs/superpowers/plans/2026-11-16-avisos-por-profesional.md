# Avisos por profesional — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que Daniela reciba todos los movimientos del estudio con el nombre de quien atiende, y que cada profesional reciba los avisos de sus propios turnos y su agenda del día siguiente.

**Architecture:** Una capa nueva `lib/avisos.js` decide *quién recibe qué* (resuelve la profesional del turno, arma los destinatarios y saca los repetidos). `services/whatsapp.js` pasa a exponer constructores de texto puros más el transporte que ya tiene. `lib/agenda.js` (nuevo, puro) agrupa los turnos del día y calcula el horario del estudio. `lib/scheduler.js` queda como cableado del cron.

**Tech Stack:** Node + Express, Prisma 6, Wassenger vía axios, `node --test` (`npm test`).

**Spec:** `docs/superpowers/specs/2026-11-16-avisos-por-profesional-design.md`

## Global Constraints

- Los avisos son *fire and forget*: todo call site mantiene su `.catch()` que solo loguea. Un aviso que falla nunca puede tumbar una reserva.
- Los teléfonos van **sin** prefijo: `enviarWhatsApp` arma `+549<telefono>`.
- Daniela es la profesional **id 1**; su número sale de `process.env.DANIELA_TELEFONO`. El de las demás, de `profesionales.telefono`, que puede ser `null`.
- Nada de lo que recibe la clienta cambia: `enviarConfirmacion`, `enviarConfirmacionGrupo`, `enviarRecordatorio`, `enviarCancelacion`, `enviarCancelacionGrupo`, `enviarModificacion`, `enviarAsistenciaConfirmada`, `notificarWaitlist` y `notificarTurnoTomadoWaitlist` quedan intactas.
- El aviso a una profesional **nunca** incluye el teléfono de la clienta.
- Los turnos que llegan a los avisos traen `servicio` incluido y **no** traen `profesional`.
- Sin migración de base: no se toca `schema.prisma`.

## Review Focus

Pinchazos que el diseño implica y que hay que testear:

1. **Profesional sin teléfono cargado** (hoy puede ser el caso de Noemí): el aviso al estudio tiene que salir igual y el fallo queda en el log. → Task 1, Task 3.
2. **`DANIELA_TELEFONO` sin configurar**: la profesional igual recibe lo suyo; nada explota. → Task 1.
3. **Teléfonos escritos distinto** en la env y en la tabla (`'11 2345-6789'` vs `'1123456789'`): la deduplicación los tiene que ver como el mismo número, o Daniela recibe todo dos veces. → Task 1.
4. **Turno con una `profesional_id` que ya no existe** (fila borrada, dato viejo): el aviso al estudio sale sin nombre en vez de tirar excepción. → Task 3.
5. **Mañana sin ningún turno**: Daniela recibe el mensaje de descanso; las profesionales no reciben nada. → Task 6.

---

### Task 1: La regla de destinatarios

**Files:**
- Create: `lib/avisos.js`
- Test: `test/avisos-destinatarios.test.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `normalizarTelefono(tel: string|null) -> string|null` (solo dígitos; `''` → `null`)
  - `destinatarios({ telefonoEstudio, profesional, incluirEstudio }) -> Array<{ telefono: string, tipo: 'estudio'|'profesional', profesionalNombre: string|null }>`
    - `profesional`: `{ nombre, telefono } | null`
    - `incluirEstudio` por default `true`
    - el estudio va primero; el repetido se cae (gana el de tipo `estudio`)

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { destinatarios, normalizarTelefono } = require('../lib/avisos');

const noemi = { nombre: 'Noemí', telefono: '1198765432' };
const daniela = { nombre: 'Daniela', telefono: '11 2345-6789' };
const ESTUDIO = '1123456789';

test('el estudio y la profesional reciben, en ese orden', () => {
  const d = destinatarios({ telefonoEstudio: ESTUDIO, profesional: noemi });
  assert.deepEqual(d.map(x => [x.telefono, x.tipo]), [
    [ESTUDIO, 'estudio'],
    ['1198765432', 'profesional']
  ]);
  assert.equal(d[0].profesionalNombre, 'Noemí');
});

test('el turno de Daniela sale una sola vez, aunque el numero este escrito distinto', () => {
  const d = destinatarios({ telefonoEstudio: ESTUDIO, profesional: daniela });
  assert.equal(d.length, 1);
  assert.equal(d[0].tipo, 'estudio');
});

test('una profesional sin telefono no frena el aviso al estudio', () => {
  const d = destinatarios({ telefonoEstudio: ESTUDIO, profesional: { nombre: 'Noemí', telefono: null } });
  assert.deepEqual(d.map(x => x.tipo), ['estudio']);
});

test('sin DANIELA_TELEFONO la profesional igual recibe lo suyo', () => {
  const d = destinatarios({ telefonoEstudio: null, profesional: noemi });
  assert.deepEqual(d.map(x => x.tipo), ['profesional']);
});

test('el panel avisa solo a la profesional', () => {
  const d = destinatarios({ telefonoEstudio: ESTUDIO, profesional: noemi, incluirEstudio: false });
  assert.deepEqual(d.map(x => x.telefono), ['1198765432']);
});

test('un turno propio cargado desde el panel no manda nada', () => {
  assert.deepEqual(destinatarios({ telefonoEstudio: ESTUDIO, profesional: daniela, incluirEstudio: false }), []);
});

test('la profesional que no existe no rompe: solo el estudio', () => {
  const d = destinatarios({ telefonoEstudio: ESTUDIO, profesional: null });
  assert.deepEqual(d.map(x => x.tipo), ['estudio']);
  assert.equal(d[0].profesionalNombre, null);
});

test('normalizarTelefono deja solo digitos', () => {
  assert.equal(normalizarTelefono('11 2345-6789'), '1123456789');
  assert.equal(normalizarTelefono(''), null);
  assert.equal(normalizarTelefono(null), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/avisos-destinatarios.test.js`
Expected: FAIL — `Cannot find module '../lib/avisos'`

- [ ] **Step 3: Implement `normalizarTelefono` y `destinatarios` en `lib/avisos.js`**

Archivo nuevo, con el comentario de cabecera que explica por qué existe la capa (dónde se contesta "quién recibe esto"). Solo estas dos funciones puras por ahora; nada de Prisma todavía.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/avisos-destinatarios.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/avisos.js test/avisos-destinatarios.test.js
git commit -m "feat(avisos): la regla de quien recibe cada aviso"
```

---

### Task 2: Los textos de los avisos de turno

**Files:**
- Modify: `services/whatsapp.js` (agregar constructores de texto; las funciones `notificar*ADaniela` se borran en la Task 3, no acá)
- Test: `test/avisos-textos.test.js`

**Interfaces:**
- Consumes: nada.
- Produces, todos puros y exportados desde `services/whatsapp.js`:
  - `textoNuevoTurno(turno, { tipo, profesionalNombre }) -> string`
  - `textoNuevoTurnoGrupo(turnos, { tipo, profesionalNombre }) -> string`
  - `textoCancelacion(turno, { tipo, profesionalNombre }) -> string`
  - `textoCancelacionGrupo(turnos, { tipo, profesionalNombre }) -> string`
  - `textoModificacion(turnoAnterior, turnoNuevo, { tipo, profesionalNombre }) -> string`

  `tipo: 'estudio'` arma el texto que hay hoy más una línea `👩 <profesionalNombre>` (se omite si es `null`). `tipo: 'profesional'` arma el texto en segunda persona ("Te agendaron un turno", "Se cancelo un turno tuyo", "Te movieron un turno"), **sin** el teléfono de la clienta y sin la línea de profesional.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { textoNuevoTurno, textoCancelacion, textoModificacion, textoNuevoTurnoGrupo } = require('../services/whatsapp');

const turno = {
  cliente_nombre: 'Carla', cliente_apellido: 'Giménez', cliente_telefono: '1123456789',
  fecha: new Date('2026-11-18T00:00:00-03:00'), hora_inicio: '15:00', hora_fin: '16:30',
  servicio: { nombre: 'PRP' }
};

test('al estudio: dice quien atiende y lleva el telefono de la clienta', () => {
  const t = textoNuevoTurno(turno, { tipo: 'estudio', profesionalNombre: 'Noemí' });
  assert.match(t, /👩 Noemí/);
  assert.match(t, /1123456789/);
  assert.match(t, /PRP/);
  assert.match(t, /15:00/);
});

test('a la profesional: sin telefono de la clienta y sin la linea de profesional', () => {
  const t = textoNuevoTurno(turno, { tipo: 'profesional', profesionalNombre: 'Noemí' });
  assert.doesNotMatch(t, /1123456789/);
  assert.doesNotMatch(t, /👩/);
  assert.match(t, /Carla Giménez/);
  assert.match(t, /PRP/);
});

test('sin nombre de profesional el texto del estudio no queda roto', () => {
  const t = textoNuevoTurno(turno, { tipo: 'estudio', profesionalNombre: null });
  assert.doesNotMatch(t, /👩/);
  assert.match(t, /PRP/);
});

test('la cancelacion a la profesional no lleva el telefono', () => {
  const t = textoCancelacion(turno, { tipo: 'profesional', profesionalNombre: 'Noemí' });
  assert.doesNotMatch(t, /1123456789/);
  assert.match(t, /15:00/);
});

test('la modificacion muestra el antes y el despues', () => {
  const nuevo = { ...turno, fecha: new Date('2026-11-20T00:00:00-03:00'), hora_inicio: '17:00' };
  const t = textoModificacion(turno, nuevo, { tipo: 'estudio', profesionalNombre: 'Noemí' });
  assert.match(t, /15:00/);
  assert.match(t, /17:00/);
  assert.match(t, /👩 Noemí/);
});

test('el grupo lista los servicios y el rango completo', () => {
  const segundo = { ...turno, hora_inicio: '16:30', hora_fin: '17:30', servicio: { nombre: 'Vitamina C' } };
  const t = textoNuevoTurnoGrupo([turno, segundo], { tipo: 'profesional', profesionalNombre: 'Noemí' });
  assert.match(t, /PRP/);
  assert.match(t, /Vitamina C/);
  assert.match(t, /15:00/);
  assert.match(t, /17:30/);
  assert.doesNotMatch(t, /1123456789/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/avisos-textos.test.js`
Expected: FAIL — `textoNuevoTurno is not a function`

- [ ] **Step 3: Implement los cinco constructores en `services/whatsapp.js`**

Reusan `formatearFecha` y el tono de los mensajes actuales (los de `notificar*ADaniela`, que siguen en el archivo hasta la Task 3). Agregarlos al `module.exports`. Ninguno consulta la base ni manda nada.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/avisos-textos.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add services/whatsapp.js test/avisos-textos.test.js
git commit -m "feat(avisos): textos para el estudio y para la profesional"
```

---

### Task 3: El fan-out y los call sites que ya existían

**Files:**
- Modify: `lib/avisos.js` (las cinco funciones async)
- Modify: `services/whatsapp.js` (borrar `notificarNuevoTurnoADaniela`, `notificarNuevoTurnoGrupoADaniela`, `notificarCancelacionADaniela`, `notificarCancelacionGrupoADaniela`, `notificarModificacionADaniela` y sus exports)
- Modify: `routes/turnos.js:26-32` (imports), `:129`, `:279`, `:393`, `:444`, `:661`, `:712`, `:736`
- Modify: `routes/webhook.js:8-10` (imports), `:128`, `:138`
- Modify: `lib/pagos-proceso.js:13-14` (imports), `:224`, `:229`
- Test: `test/avisos-envio.test.js`

**Interfaces:**
- Consumes: `destinatarios` (Task 1), los `texto*` (Task 2).
- Produces, desde `lib/avisos.js`:
  - `avisarNuevoTurno(turno, opciones) -> Promise<number>` (cuántos mensajes salieron)
  - `avisarNuevoTurnoGrupo(turnos, opciones) -> Promise<number>`
  - `avisarCancelacion(turno, opciones) -> Promise<number>`
  - `avisarCancelacionGrupo(turnos, opciones) -> Promise<number>`
  - `avisarModificacion(turnoAnterior, turnoNuevo, opciones) -> Promise<number>`

  `opciones = { incluirEstudio = true, deps = {} }`. `deps` permite inyectar `{ prisma, enviar }` en los tests; por default usa `require('./prisma')` y `enviarWhatsApp` de `services/whatsapp.js`. La profesional se resuelve con `prisma.profesional.findUnique({ where: { id: turno.profesional_id }, select: { nombre: true, telefono: true } })`; si no existe, se sigue con `profesional: null`.

  Si `turnoAnterior.profesional_id !== turnoNuevo.profesional_id`, `avisarModificacion` manda **cancelación** a la profesional que pierde el turno y **turno nuevo** a la que lo gana; al estudio (si va incluido) le manda la modificación.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { avisarNuevoTurno, avisarModificacion } = require('../lib/avisos');

const ESTUDIO = '1123456789';
const turno = {
  profesional_id: 2,
  cliente_nombre: 'Carla', cliente_apellido: 'Giménez', cliente_telefono: '1155556666',
  fecha: new Date('2026-11-18T00:00:00-03:00'), hora_inicio: '15:00', hora_fin: '16:30',
  servicio: { nombre: 'PRP' }
};

function deps({ profesional = { nombre: 'Noemí', telefono: '1198765432' }, enviados = [] } = {}) {
  return {
    prisma: { profesional: { findUnique: async () => profesional } },
    enviar: async (telefono, mensaje) => { enviados.push({ telefono, mensaje }); return true; }
  };
}

test('un turno de otra profesional sale dos veces, con textos distintos', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  await avisarNuevoTurno(turno, { deps: deps({ enviados }) });
  assert.deepEqual(enviados.map(e => e.telefono), [ESTUDIO, '1198765432']);
  assert.match(enviados[0].mensaje, /👩 Noemí/);
  assert.doesNotMatch(enviados[1].mensaje, /1155556666/);
});

test('si la profesional no tiene telefono, sale solo el del estudio', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  await avisarNuevoTurno(turno, { deps: deps({ profesional: { nombre: 'Noemí', telefono: null }, enviados }) });
  assert.equal(enviados.length, 1);
});

test('una profesional borrada no tira: el estudio se entera igual', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  await avisarNuevoTurno(turno, { deps: deps({ profesional: null, enviados }) });
  assert.equal(enviados.length, 1);
  assert.match(enviados[0].mensaje, /PRP/);
});

test('el panel avisa solo a la profesional', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  await avisarNuevoTurno(turno, { incluirEstudio: false, deps: deps({ enviados }) });
  assert.deepEqual(enviados.map(e => e.telefono), ['1198765432']);
});

test('si cambia la profesional, una se entera de la baja y la otra del alta', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  const anterior = { ...turno, profesional_id: 2 };
  const nuevo = { ...turno, profesional_id: 3, servicio: { nombre: 'Esmaltado' } };
  const porId = { 2: { nombre: 'Noemí', telefono: '1198765432' }, 3: { nombre: 'Flor', telefono: '1177778888' } };
  await avisarModificacion(anterior, nuevo, {
    incluirEstudio: false,
    deps: {
      prisma: { profesional: { findUnique: async ({ where }) => porId[where.id] } },
      enviar: async (telefono, mensaje) => { enviados.push({ telefono, mensaje }); return true; }
    }
  });
  const porTelefono = Object.fromEntries(enviados.map(e => [e.telefono, e.mensaje]));
  assert.match(porTelefono['1198765432'], /cancel/i);
  assert.match(porTelefono['1177778888'], /agendaron|nuevo/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/avisos-envio.test.js`
Expected: FAIL — `avisarNuevoTurno is not a function`

- [ ] **Step 3: Implement las cinco funciones async en `lib/avisos.js`**

Cada una: resuelve la profesional, llama a `destinatarios`, y por cada destinatario manda el `texto*` que corresponde a su `tipo`. Los envíos de un mismo aviso van en paralelo (`Promise.all`) y cada uno con su `.catch()` que loguea: que el aviso a la profesional falle no puede tapar el del estudio. Devuelve la cantidad de mensajes que salieron.

- [ ] **Step 4: Reemplazar los call sites existentes**

En `routes/turnos.js`, `routes/webhook.js` y `lib/pagos-proceso.js`: importar de `../lib/avisos` (o `./avisos`) y cambiar los nombres `notificarXADaniela` → `avisarX`, con los mismos argumentos y los mismos `.catch()`. En `routes/webhook.js` las dos llamadas están `await`-eadas: dejarlas así. Borrar las cinco funciones viejas y sus exports de `services/whatsapp.js`.

- [ ] **Step 5: Verificar que no quedó ninguna referencia colgada**

Run: `grep -rn "ADaniela" --include=*.js . | grep -v node_modules`
Expected: sin resultados. (`notificarTurnoTomadoWaitlist`, que no se toca, usa la env pero no se llama así.)

Run: `node -e "require('./routes/turnos'); require('./routes/webhook'); require('./lib/pagos-proceso'); console.log('ok')"`
Expected: `ok`

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, incluidos los tests viejos.

- [ ] **Step 7: Commit**

```bash
git add lib/avisos.js services/whatsapp.js routes/turnos.js routes/webhook.js lib/pagos-proceso.js test/avisos-envio.test.js
git commit -m "feat(avisos): cada profesional se entera de sus turnos"
```

---

### Task 4: El panel también avisa a la profesional

**Files:**
- Modify: `routes/admin.js` — `POST /turnos` (~:160), `POST /turnos/multi` (~:293), `PATCH /turnos/:id` (~:322 y ~:369), `DELETE /turnos/:id` (~:480)
- Test: `test/avisos-panel.test.js`

**Interfaces:**
- Consumes: `avisarNuevoTurno`, `avisarNuevoTurnoGrupo`, `avisarModificacion`, `avisarCancelacion` (Task 3).
- Produces: nada nuevo.

- [ ] **Step 1: Write the regression test**

El test cubre la regla, no el router: que un turno que Daniela se carga a sí misma no genere ningún mensaje. Es la red que protege la decisión 1 desde el camino del panel; si la Task 3 quedó bien, pasa de entrada.

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { avisarNuevoTurno } = require('../lib/avisos');

const ESTUDIO = '1123456789';
const turnoDeDaniela = {
  profesional_id: 1,
  cliente_nombre: 'Ana', cliente_apellido: 'Pérez', cliente_telefono: '1155556666',
  fecha: new Date('2026-11-18T00:00:00-03:00'), hora_inicio: '10:00', hora_fin: '11:00',
  servicio: { nombre: 'Belleza de pies' }
};

test('un turno que Daniela se carga a si misma no manda ningun aviso', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  const n = await avisarNuevoTurno(turnoDeDaniela, {
    incluirEstudio: false,
    deps: {
      prisma: { profesional: { findUnique: async () => ({ nombre: 'Daniela', telefono: ESTUDIO }) } },
      enviar: async (telefono, mensaje) => { enviados.push({ telefono, mensaje }); return true; }
    }
  });
  assert.equal(n, 0);
  assert.equal(enviados.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/avisos-panel.test.js`
Expected: PASS si la Task 3 quedó bien (es una verificación de la regla, no código nuevo). Si falla, el bug está en `destinatarios` o en el fan-out: arreglarlo ahí.

- [ ] **Step 3: Agregar los avisos en `routes/admin.js`**

Los cuatro, todos con `{ incluirEstudio: false }` y `.catch()` que loguea:

- `POST /turnos`: `avisarNuevoTurno(turno, ...)` **fuera** del `if (debeNotificar)`. El check dice "Avisar por WhatsApp a la clienta": no manda sobre el aviso interno.
- `POST /turnos/multi`: `avisarNuevoTurnoGrupo(turnosCreados, ...)`, también fuera del `if`.
- `PATCH /turnos/:id`: agregar `include: { servicio: true }` al `findUnique` de `turnoActual` (hace falta para el texto de la cancelación cuando cambia la profesional) y llamar a `avisarModificacion(turnoActual, turno, ...)` solo si `cambioServicio || cambioFecha || cambioHora`.
- `DELETE /turnos/:id`: `avisarCancelacion(turno, ...)`.

- [ ] **Step 4: Verificar**

Run: `node -e "require('./routes/admin'); console.log('ok')"`
Expected: `ok`

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add routes/admin.js test/avisos-panel.test.js
git commit -m "feat(avisos): los turnos cargados desde el panel avisan a la profesional"
```

---

### Task 5: Agrupar el día y calcular el horario del estudio

**Files:**
- Create: `lib/agenda.js`
- Test: `test/agenda.test.js`

**Interfaces:**
- Consumes: nada.
- Produces, todo puro:
  - `agruparPorReserva(turnos) -> Array<Array<turno>>` — agrupa por `grupo_reserva` (el turno suelto queda como grupo de 1), ordena cada grupo por `orden_en_grupo` y los grupos por `hora_inicio`.
  - `horarioDelEstudio(grupos) -> { inicio: string, fin: string } | null` — primer `hora_inicio` y último `hora_fin` del día; `null` si no hay grupos.
  - `agendaPorProfesional(grupos) -> Array<{ profesional: { id, nombre, orden }, grupos: Array<Array<turno>> }>` — ordenada por `orden` y después por `nombre`; solo las que tienen turnos.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { agruparPorReserva, horarioDelEstudio, agendaPorProfesional } = require('../lib/agenda');

const dani = { id: 1, nombre: 'Daniela', orden: 0 };
const noemi = { id: 2, nombre: 'Noemí', orden: 1 };
const t = (hora_inicio, hora_fin, profesional, extra = {}) => ({
  hora_inicio, hora_fin, profesional, profesional_id: profesional.id,
  servicio: { nombre: 'X' }, cliente_nombre: 'A', cliente_apellido: 'B', ...extra
});

test('los turnos de una misma reserva quedan en un grupo, en orden', () => {
  const turnos = [
    t('10:00', '11:00', dani, { grupo_reserva: 'g1', orden_en_grupo: 1 }),
    t('11:00', '11:30', dani, { grupo_reserva: 'g1', orden_en_grupo: 2 }),
    t('15:00', '16:30', noemi)
  ];
  const grupos = agruparPorReserva(turnos);
  assert.equal(grupos.length, 2);
  assert.equal(grupos[0].length, 2);
  assert.equal(grupos[0][0].hora_inicio, '10:00');
});

test('el horario del estudio va del primer turno al ultimo', () => {
  const grupos = agruparPorReserva([t('15:00', '16:30', noemi), t('10:00', '11:00', dani)]);
  assert.deepEqual(horarioDelEstudio(grupos), { inicio: '10:00', fin: '16:30' });
});

test('un dia sin turnos no tiene horario', () => {
  assert.equal(horarioDelEstudio([]), null);
});

test('el ultimo fin no es el del ultimo grupo si otro termina mas tarde', () => {
  const grupos = agruparPorReserva([t('10:00', '19:30', dani), t('15:00', '16:00', noemi)]);
  assert.deepEqual(horarioDelEstudio(grupos), { inicio: '10:00', fin: '19:30' });
});

test('se agrupa por profesional, en el orden del panel', () => {
  const grupos = agruparPorReserva([t('15:00', '16:30', noemi), t('10:00', '11:00', dani)]);
  const porProf = agendaPorProfesional(grupos);
  assert.deepEqual(porProf.map(p => p.profesional.nombre), ['Daniela', 'Noemí']);
  assert.equal(porProf[0].grupos.length, 1);
});

test('la profesional sin turnos no aparece', () => {
  const porProf = agendaPorProfesional(agruparPorReserva([t('10:00', '11:00', dani)]));
  assert.deepEqual(porProf.map(p => p.profesional.id), [1]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/agenda.test.js`
Expected: FAIL — `Cannot find module '../lib/agenda'`

- [ ] **Step 3: Implement las tres funciones en `lib/agenda.js`**

`agruparPorReserva` sale de mover acá la lógica que hoy está inline en `lib/scheduler.js:118-139`. Las horas son strings `HH:MM`, así que se comparan con `localeCompare`, como en el resto del repo.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/agenda.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/agenda.js test/agenda.test.js
git commit -m "feat(agenda): agrupar el dia y el horario del estudio"
```

---

### Task 6: Las agendas de mañana

**Files:**
- Modify: `services/whatsapp.js` (dos textos nuevos; borrar `enviarResumenDiarioADaniela` y su export)
- Modify: `lib/avisos.js` (`enviarAgendasDeManana`)
- Modify: `lib/scheduler.js:111-142` (`enviarResumenDiario` pasa a ser una llamada) y `:4` (imports)
- Test: `test/agenda-textos.test.js`, `test/agenda-envio.test.js`

**Interfaces:**
- Consumes: `agruparPorReserva`, `horarioDelEstudio`, `agendaPorProfesional` (Task 5); `destinatarios`, `normalizarTelefono` (Task 1).
- Produces:
  - `textoAgendaEstudio(fecha, { horario, porProfesional }) -> string` en `services/whatsapp.js` — encabezado `📋 Agenda de mañana (<fecha>)`, línea `🏠 Estudio abierto de <inicio> a <fin>`, y una sección `👩 <nombre>` por profesional con sus bloques. Sin turnos: el mensaje de descanso que hay hoy.
  - `textoAgendaProfesional(fecha, grupos) -> string` en `services/whatsapp.js` — los bloques de ella, con `🌅 Primer turno` y `🌙 Terminás`, sin teléfonos de clientas.
  - `enviarAgendasDeManana(fecha, opciones) -> Promise<number>` en `lib/avisos.js` — una consulta de los turnos confirmados de esa fecha (`include: { servicio: true, profesional: true }`), manda la del estudio a `DANIELA_TELEFONO` y la de cada profesional a su teléfono, salteando el número del estudio (ya recibió la completa) y a las que no tienen turnos. `opciones.deps` igual que en la Task 3.

- [ ] **Step 1: Write the failing tests**

```js
// test/agenda-textos.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { textoAgendaEstudio, textoAgendaProfesional } = require('../services/whatsapp');

const fecha = new Date('2026-11-18T00:00:00-03:00');
const bloque = (hora_inicio, hora_fin, nombre) => [{
  hora_inicio, hora_fin, servicio: { nombre: 'PRP' },
  cliente_nombre: nombre, cliente_apellido: 'Gómez', cliente_telefono: '1155556666'
}];

test('la del estudio abre con el horario y lista por profesional', () => {
  const t = textoAgendaEstudio(fecha, {
    horario: { inicio: '10:00', fin: '19:30' },
    porProfesional: [
      { profesional: { nombre: 'Daniela' }, grupos: [bloque('10:00', '11:00', 'Ana')] },
      { profesional: { nombre: 'Noemí' }, grupos: [bloque('15:00', '16:30', 'Carla')] }
    ]
  });
  assert.match(t, /🏠 Estudio abierto de 10:00 a 19:30/);
  assert.match(t, /👩 Daniela/);
  assert.match(t, /👩 Noemí/);
  assert.ok(t.indexOf('Daniela') < t.indexOf('Noemí'));
  assert.match(t, /Ana Gómez/);
});

test('un dia sin turnos sigue avisando que no hay nada', () => {
  const t = textoAgendaEstudio(fecha, { horario: null, porProfesional: [] });
  assert.match(t, /18\/11/);
  assert.doesNotMatch(t, /🏠/);
});

test('la de la profesional trae solo lo suyo y sin telefonos', () => {
  const t = textoAgendaProfesional(fecha, [bloque('15:00', '16:30', 'Carla')]);
  assert.match(t, /15:00/);
  assert.match(t, /Carla Gómez/);
  assert.doesNotMatch(t, /1155556666/);
  assert.doesNotMatch(t, /👩/);
});
```

```js
// test/agenda-envio.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { enviarAgendasDeManana } = require('../lib/avisos');

const ESTUDIO = '1123456789';
const dani = { id: 1, nombre: 'Daniela', orden: 0, telefono: ESTUDIO };
const noemi = { id: 2, nombre: 'Noemí', orden: 1, telefono: '1198765432' };
const t = (hora_inicio, hora_fin, profesional) => ({
  hora_inicio, hora_fin, profesional, profesional_id: profesional.id,
  servicio: { nombre: 'PRP' }, cliente_nombre: 'Ana', cliente_apellido: 'Gómez', cliente_telefono: '1155556666'
});

function deps(turnos, enviados) {
  return {
    prisma: { turno: { findMany: async () => turnos } },
    enviar: async (telefono, mensaje) => { enviados.push({ telefono, mensaje }); return true; }
  };
}

test('Daniela recibe la del estudio y Noemi la suya', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  await enviarAgendasDeManana(new Date('2026-11-18'), { deps: deps([t('10:00', '11:00', dani), t('15:00', '16:30', noemi)], enviados) });
  assert.deepEqual(enviados.map(e => e.telefono), [ESTUDIO, '1198765432']);
  assert.match(enviados[0].mensaje, /🏠 Estudio abierto de 10:00 a 16:30/);
  assert.doesNotMatch(enviados[1].mensaje, /Estudio abierto/);
});

test('Daniela no recibe dos mensajes por sus propios turnos', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  await enviarAgendasDeManana(new Date('2026-11-18'), { deps: deps([t('10:00', '11:00', dani)], enviados) });
  assert.equal(enviados.length, 1);
});

test('la profesional sin turnos manana no recibe nada', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  await enviarAgendasDeManana(new Date('2026-11-18'), { deps: deps([t('10:00', '11:00', dani)], enviados) });
  assert.deepEqual(enviados.map(e => e.telefono), [ESTUDIO]);
});

test('un dia vacio igual le llega a Daniela', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  await enviarAgendasDeManana(new Date('2026-11-18'), { deps: deps([], enviados) });
  assert.equal(enviados.length, 1);
});

test('la profesional sin telefono cargado no frena la del estudio', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  const sinTel = { ...noemi, telefono: null };
  await enviarAgendasDeManana(new Date('2026-11-18'), { deps: deps([t('15:00', '16:30', sinTel)], enviados) });
  assert.deepEqual(enviados.map(e => e.telefono), [ESTUDIO]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/agenda-textos.test.js test/agenda-envio.test.js`
Expected: FAIL — `textoAgendaEstudio is not a function` / `enviarAgendasDeManana is not a function`

- [ ] **Step 3: Implement los dos textos y `enviarAgendasDeManana`**

Los textos en `services/whatsapp.js`, reusando `formatearFecha`. `enviarAgendasDeManana` en `lib/avisos.js`: una consulta, `agruparPorReserva`, `horarioDelEstudio`, `agendaPorProfesional`, y los envíos con el mismo criterio de deduplicación por número normalizado. Borrar `enviarResumenDiarioADaniela` y su export.

- [ ] **Step 4: Dejar `lib/scheduler.js` como cableado**

`enviarResumenDiario()` pasa a calcular la fecha de mañana y llamar a `enviarAgendasDeManana`; se va de ahí la consulta y el agrupado (ahora en `lib/agenda.js`). El cron de las 19:00 ARG no se toca.

- [ ] **Step 5: Verificar**

Run: `npm test`
Expected: PASS

Run: `node -e "require('./lib/scheduler'); console.log('ok')"`
Expected: `ok`

Run: `grep -rn "enviarResumenDiarioADaniela" --include=*.js . | grep -v node_modules`
Expected: sin resultados.

- [ ] **Step 6: Commit**

```bash
git add services/whatsapp.js lib/avisos.js lib/scheduler.js test/agenda-textos.test.js test/agenda-envio.test.js
git commit -m "feat(agenda): resumen del estudio por profesional y agenda propia de cada una"
```

---

### Task 7: Lo que hay que hacer para ponerlo en producción

**Files:**
- Create: `docs/superpowers/PENDIENTE-avisos-por-profesional.md`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: nada de código.

- [ ] **Step 1: Escribir el PENDIENTE**

Mismo formato que `PENDIENTE-camilla-compartida.md`. Tiene que decir:

- **No hay migración:** no se toca el schema, así que el orden de deploy no importa y no hay ventana de caída.
- **Cargar el teléfono de cada profesional** en el panel → Equipo. Sin teléfono, la profesional no recibe nada (y el aviso a Daniela sale igual). Verificar el de Noemí, que puede estar vacío.
- **Verificar `DANIELA_TELEFONO`** en Railway: es de dónde sale el aviso del estudio.
- Deploy del backend a Railway. El frontend **no se toca**.
- Checklist de prueba: reservar desde la web un servicio de Noemí (dos mensajes, uno a cada una); reservar uno de Daniela (un solo mensaje); cargar un turno de Noemí desde el panel con el check de la clienta destildado (le llega a Noemí igual, a Daniela no); cancelar desde el link de la clienta; esperar las 19:00 y comparar las dos agendas.
- Lo que queda afuera a propósito: la waitlist no le avisa a la profesional; la liquidación se sigue copiando a mano; el staff sigue sin acceso al panel.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/PENDIENTE-avisos-por-profesional.md
git commit -m "docs: pasos para poner los avisos por profesional en produccion"
```
