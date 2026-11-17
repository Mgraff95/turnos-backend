const test = require('node:test');
const assert = require('node:assert/strict');

const { agruparPorReserva, horarioDelEstudio, agendaPorProfesional } = require('../lib/agenda');

// Lo que hace falta para armar el resumen del día: juntar los turnos de una
// misma reserva, saber de qué hora a qué hora está abierto el estudio y partir
// el día por profesional. Puro, porque es donde se puede equivocar la cuenta.

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
