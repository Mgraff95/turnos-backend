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
