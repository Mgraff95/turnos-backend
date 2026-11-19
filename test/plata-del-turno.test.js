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
