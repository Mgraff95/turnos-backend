const test = require('node:test');
const assert = require('node:assert/strict');

const { plataDelTurno } = require('../lib/reservas');

// La foto de la plata que se congela en el turno. Un solo lugar para los dos
// caminos: el alta y la edición que lo reasigna.

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

// ── Hallazgo del review de rama (Critical) ─────
//
// Reasignar no cambia qué se le hace a la clienta ni cuánto se le cobró: lo
// único que cambia de manos es la comisión. Recalcular el precio_base movía la
// liquidación de un mes ya compartido a los precios de hoy, contra lo que dice
// el propio schema ("NO se recalculan nunca").
const { plataReasignada } = require('../lib/reservas');

const turnoDeOctubre = { precio_base: 60000, comision_pct: null, comision_monto: null };
const prpMasCaroHoy = { id: 7, profesional_id: 1, precio_pesos: 75000, comision_pct: null };

test('reasignar no mueve el precio congelado: solo recalcula la comision', () => {
  const r = plataReasignada(turnoDeOctubre, prpMasCaroHoy, noemi, []);
  assert.equal(r.precio_base, undefined);
  assert.equal(r.comision_pct, 50);
  assert.equal(r.comision_monto, 30000); // 50% de los 60000 congelados, no de los 75000 de hoy
});

test('reasignar a la dueña del estudio deja el turno sin comision y sin tocar el precio', () => {
  const daniela = { id: 1, comision_pct_default: null };
  const r = plataReasignada(turnoDeOctubre, prpMasCaroHoy, daniela, []);
  assert.deepEqual(r, { comision_pct: null, comision_monto: null });
});

test('un turno viejo sin precio congelado si se calcula completo', () => {
  const sinFoto = { precio_base: null, comision_pct: null, comision_monto: null };
  const r = plataReasignada(sinFoto, prpMasCaroHoy, noemi, []);
  assert.equal(r.precio_base, 75000);
  assert.equal(r.comision_monto, 37500);
});

// ── Hallazgo del review de rama (Important) ────
//
// Lo que decide si se recongela la plata vivía suelto en el cuerpo de la ruta,
// protegido solo por haberlo leído. Es justo el lugar donde una edición futura
// recongela el precio de un turno sin querer, que es el anti-objetivo #1 del
// diseño: una liquidación ya compartida que cambia sola.
const { camposDelCambioDeServicio } = require('../lib/reservas');

const turnoDePrp = { servicio_id: 7, profesional_id: 2, precio_base: 60000 };
const esmaltadoDeDaniela = { id: 3, profesional_id: 1, precio_pesos: 20000, comision_pct: null };
const daniela = { id: 1, comision_pct_default: null };

test('sin servicio nuevo, el update no toca la plata ni los extras', () => {
  const r = camposDelCambioDeServicio(turnoDePrp, null, null, []);
  assert.deepEqual(r, { servicio_id: 7, profesional_id: 2 });
  assert.equal('precio_base' in r, false);
  assert.equal('extras_ids' in r, false);
});

test('con el MISMO servicio, se comporta como si no hubiera cambio', () => {
  const mismo = { id: 7, profesional_id: 2, precio_pesos: 99999, comision_pct: null };
  const r = camposDelCambioDeServicio(turnoDePrp, mismo, noemi, []);
  assert.deepEqual(r, { servicio_id: 7, profesional_id: 2 });
});

test('con un servicio nuevo, se recongela todo y el turno cambia de agenda', () => {
  const r = camposDelCambioDeServicio(turnoDePrp, esmaltadoDeDaniela, daniela, []);
  assert.equal(r.servicio_id, 3);
  assert.equal(r.profesional_id, 1);
  assert.equal(r.precio_base, 20000);
  assert.deepEqual(r.extras_ids, []);
  assert.equal(r.comision_pct, null);
});

test('los extras que sobreviven entran en el precio y en la lista guardada', () => {
  const extras = [{ id: 5, precio_pesos: 3000, precio_variable: false }];
  const r = camposDelCambioDeServicio(turnoDePrp, esmaltadoDeDaniela, daniela, extras);
  assert.equal(r.precio_base, 23000);
  assert.deepEqual(r.extras_ids, [5]);
});
