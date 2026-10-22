const test = require('node:test');
const assert = require('node:assert/strict');

const { resolverComision, validarPct } = require('../lib/comisiones');

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

// El que importa: distingue "el servicio no tiene excepcion" (null, hay que
// heredar) de "el servicio tiene 0% de comision" (0, valido y no se hereda).
// Obliga a usar ?? y no ||.
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

// ── validarPct ──
// Sin esto, Daniela tipea 300 en el panel y la liquidacion le pide a Elsa el
// triple de lo que facturo.

test('validarPct acepta un porcentaje valido', () => {
  assert.equal(validarPct(30), 30);
  assert.equal(validarPct('30'), 30);
  assert.equal(validarPct(0), 0);
  assert.equal(validarPct(100), 100);
  assert.equal(validarPct(15.5), 15.5);
});

test('validarPct trata vacio y null como "sin comision"', () => {
  assert.equal(validarPct(null), null);
  assert.equal(validarPct(undefined), null);
  assert.equal(validarPct(''), null);
});

test('validarPct rechaza fuera de 0 a 100', () => {
  assert.throws(() => validarPct(300), /COMISION_INVALIDA/);
  assert.throws(() => validarPct(-1), /COMISION_INVALIDA/);
  assert.throws(() => validarPct(100.01), /COMISION_INVALIDA/);
});

test('validarPct rechaza lo que no es numero', () => {
  assert.throws(() => validarPct('treinta'), /COMISION_INVALIDA/);
  assert.throws(() => validarPct({}), /COMISION_INVALIDA/);
});
