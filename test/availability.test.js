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

// Misma trampa, rama nueva: el filtro de camilla tambien vive adentro del AND,
// asi que tiene que sobrevivir al mismo spread. Si se hubiera puesto en `OR`,
// el checkout lo pisaria y un hold de camilla ajeno dejaria de congelar la cama.
test('el filtro de camilla sobrevive al OR de solapamiento', () => {
  const combinado = Object.assign(whereHoldsActivos(FECHA, 2, true), { OR: OR_SOLAPAMIENTO });
  assert.equal(JSON.stringify(combinado).includes('usa_camilla'), true);
  assert.equal(filtraPorProfesional(combinado), true);
  assert.deepEqual(combinado.OR, OR_SOLAPAMIENTO);
});

test('sin camilla el where no menciona usa_camilla', () => {
  // Un servicio de unas no tiene que mirar los holds de camilla de nadie.
  const w = whereHoldsActivos(FECHA, 2);
  assert.equal(JSON.stringify(w).includes('usa_camilla'), false);
});

// ── Excluir el turno que se está editando ──────
//
// Hallazgo del review de rama (Critical): sin esto, el panel tenía que
// reinsertar a mano la hora original en la pantalla, y ese parche no sabía nada
// del horario de trabajo de la otra profesional: ofrecía horas en agendas que
// ese día no atienden, y el motor las aceptaba porque no mira los rangos.
const { whereTurnosQueOcupan } = require('../lib/availability');

test('sin exclusiones el where no habla de ids', () => {
  const w = whereTurnosQueOcupan(FECHA, 2, false);
  assert.equal(w.id, undefined);
  assert.equal(w.profesional_id, 2);
  assert.equal(w.estado, 'confirmado');
});

test('el turno que se edita no ocupa su propio horario', () => {
  const w = whereTurnosQueOcupan(FECHA, 2, false, [42]);
  assert.deepEqual(w.id, { notIn: [42] });
});

test('la exclusion tambien vale para la camilla, que es la que cruza agendas', () => {
  const w = whereTurnosQueOcupan(FECHA, 2, true, [42]);
  assert.deepEqual(w.id, { notIn: [42] });
  assert.equal(w.profesional_id, undefined);
  assert.equal(w.OR.length, 2);
});
