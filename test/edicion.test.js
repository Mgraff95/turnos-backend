const test = require('node:test');
const assert = require('node:assert/strict');

const { cambiosDeTurno, puedeReasignar, duracionConExtras } = require('../lib/edicion');

// Las decisiones del PATCH del panel, sacadas de la ruta para poder probarlas.
// Son las que se equivocan en silencio: recongelar la plata cuando no hacía
// falta cambia una liquidación vieja, y avisarle a la clienta de un movimiento
// interno la confunde.

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
