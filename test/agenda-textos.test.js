const test = require('node:test');
const assert = require('node:assert/strict');

const { textoAgendaEstudio, textoAgendaProfesional } = require('../services/whatsapp');

// Los dos resúmenes de las 19:00. El del estudio abre con el horario y parte el
// día por profesional; el de cada profesional trae solo lo suyo.

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

// Hallazgo del review de rama: con un turno cuya fila de profesionales ya no
// existe, la sección salía titulada literalmente "👩 null" en el mensaje que
// Daniela lee todas las noches. El camino de los avisos sí tenía el guard
// (lineaProfesional omite la línea sin nombre); este no.
test('una profesional sin nombre no imprime null', () => {
  const t = textoAgendaEstudio(fecha, {
    horario: { inicio: '10:00', fin: '11:00' },
    porProfesional: [{ profesional: { nombre: null }, grupos: [bloque('10:00', '11:00', 'Ana')] }]
  });
  assert.doesNotMatch(t, /null/);
  assert.match(t, /Sin asignar/);
  assert.match(t, /Ana Gómez/);
});
