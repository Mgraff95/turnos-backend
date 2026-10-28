const test = require('node:test');
const assert = require('node:assert/strict');

const { puedeModificarse } = require('../lib/fechas');

// Para mover un turno hacen falta DOS cosas, no una:
//  - que el turno ORIGINAL este a mas de 24 horas (no se toca algo inminente)
//  - que el horario NUEVO tambien lo este (no se mueve a dentro de dos horas)
//
// Validar solo el original dejaria el agujero: a 25 horas del turno, la clienta
// podria moverlo a dentro de dos.

const AHORA = new Date('2026-11-05T15:00:00.000Z'); // 12:00 ARG del jueves 5

test('acepta cuando el original y el nuevo estan holgadamente lejos', () => {
  const turno = { fecha: '2026-11-10', hora_inicio: '11:00' };
  const r = puedeModificarse(turno, '2026-11-12', '16:00', AHORA);
  assert.equal(r.ok, true);
});

test('rechaza si el turno ORIGINAL esta dentro de las 24 horas', () => {
  // 10:00 ARG del 6 = 22 horas despues
  const turno = { fecha: '2026-11-06', hora_inicio: '10:00' };
  const r = puedeModificarse(turno, '2026-11-20', '10:00', AHORA);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'ORIGINAL_DEMASIADO_CERCA');
});

// EL AGUJERO que motiva la segunda validacion.
test('rechaza si el horario NUEVO esta dentro de las 24 horas', () => {
  // original a 5 dias: holgado
  const turno = { fecha: '2026-11-10', hora_inicio: '11:00' };
  // nuevo: 14:00 ARG del 6 = 26 horas... no. 10:00 ARG del 6 = 22 horas
  const r = puedeModificarse(turno, '2026-11-06', '10:00', AHORA);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'NUEVO_DEMASIADO_CERCA');
});

test('rechaza mover el turno al pasado', () => {
  const turno = { fecha: '2026-11-10', hora_inicio: '11:00' };
  const r = puedeModificarse(turno, '2026-10-01', '10:00', AHORA);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'NUEVO_DEMASIADO_CERCA');
});

test('el borde se mide en hora argentina, no en UTC', () => {
  // 23:00 UTC del 5 = 20:00 ARG del 5
  const ahora = new Date('2026-11-05T23:00:00.000Z');
  const turno = { fecha: '2026-11-10', hora_inicio: '11:00' };
  // 19:00 ARG del 6 = 23 horas -> adentro de la ventana, se rechaza
  assert.equal(puedeModificarse(turno, '2026-11-06', '19:00', ahora).ok, false);
  // 21:00 ARG del 6 = 25 horas -> afuera, se acepta
  assert.equal(puedeModificarse(turno, '2026-11-06', '21:00', ahora).ok, true);
});

test('acepta la fecha como la devuelve Prisma, con hora pegada', () => {
  const turno = { fecha: '2026-11-10T00:00:00.000Z', hora_inicio: '11:00' };
  assert.equal(puedeModificarse(turno, '2026-11-12', '16:00', AHORA).ok, true);
});

test('si no cambia nada, se evalua igual contra el original', () => {
  const turno = { fecha: '2026-11-10', hora_inicio: '11:00' };
  const r = puedeModificarse(turno, '2026-11-10', '11:00', AHORA);
  assert.equal(r.ok, true);
});
