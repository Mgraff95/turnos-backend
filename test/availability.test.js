const test = require('node:test');
const assert = require('node:assert/strict');

const { whereHoldsActivos } = require('../lib/availability');

const FECHA = new Date('2026-11-03T00:00:00.000Z');

// Condicion de solapamiento, igual que la que arma hayHoldEnConflicto.
const OR_SOLAPAMIENTO = [
  { hora_inicio: { lte: '15:00' }, hora_fin: { gt: '15:00' } },
  { hora_inicio: { lt: '16:00' }, hora_fin: { gte: '16:00' } }
];

// Devuelve true si en algun lado del where quedo un filtro por profesional.
function filtraPorProfesional(where) {
  return JSON.stringify(where).includes('profesional_id');
}

test('whereHoldsActivos sin profesional no filtra por agenda', () => {
  // Es lo que necesitan los listados del panel: todos los pagos en curso.
  const w = whereHoldsActivos(FECHA);
  assert.equal(filtraPorProfesional(w), false);
});

test('whereHoldsActivos con profesional filtra por agenda', () => {
  const w = whereHoldsActivos(FECHA, 2);
  assert.equal(filtraPorProfesional(w), true);
});

// EL QUE IMPORTA.
//
// hayHoldEnConflicto combina el where base con la condicion de solapamiento
// usando Object.assign, y routes/pagos.js hace lo mismo con un spread. Si el
// filtro de profesional vive en `where.OR`, esa combinacion lo PISA y el hold
// de una profesional pasa a bloquear la agenda de la otra: justo lo que esta
// rama existe para evitar.
test('el filtro de profesional sobrevive a combinarlo con un OR de solapamiento', () => {
  const combinado = Object.assign(whereHoldsActivos(FECHA, 2), { OR: OR_SOLAPAMIENTO });
  assert.equal(
    filtraPorProfesional(combinado),
    true,
    'el filtro de profesional se perdio al agregar el OR de solapamiento'
  );
});

test('la condicion de solapamiento tambien sobrevive', () => {
  const combinado = Object.assign(whereHoldsActivos(FECHA, 2), { OR: OR_SOLAPAMIENTO });
  assert.deepEqual(combinado.OR, OR_SOLAPAMIENTO);
});
