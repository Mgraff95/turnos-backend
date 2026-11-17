const test = require('node:test');
const assert = require('node:assert/strict');

const { textoNuevoTurno, textoCancelacion, textoModificacion, textoNuevoTurnoGrupo } = require('../services/whatsapp');

// Los dos textos de un mismo hecho. El del estudio dice quién atiende y lleva
// el teléfono de la clienta; el de la profesional va en segunda persona y sin
// datos de contacto de la clienta, que es lo que se decidió en el diseño.

const turno = {
  cliente_nombre: 'Carla', cliente_apellido: 'Giménez', cliente_telefono: '1123456789',
  fecha: new Date('2026-11-18T00:00:00-03:00'), hora_inicio: '15:00', hora_fin: '16:30',
  servicio: { nombre: 'PRP' }
};

test('al estudio: dice quien atiende y lleva el telefono de la clienta', () => {
  const t = textoNuevoTurno(turno, { tipo: 'estudio', profesionalNombre: 'Noemí' });
  assert.match(t, /👩 Noemí/);
  assert.match(t, /1123456789/);
  assert.match(t, /PRP/);
  assert.match(t, /15:00/);
});

test('a la profesional: sin telefono de la clienta y sin la linea de profesional', () => {
  const t = textoNuevoTurno(turno, { tipo: 'profesional', profesionalNombre: 'Noemí' });
  assert.doesNotMatch(t, /1123456789/);
  assert.doesNotMatch(t, /👩/);
  assert.match(t, /Carla Giménez/);
  assert.match(t, /PRP/);
});

test('sin nombre de profesional el texto del estudio no queda roto', () => {
  const t = textoNuevoTurno(turno, { tipo: 'estudio', profesionalNombre: null });
  assert.doesNotMatch(t, /👩/);
  assert.match(t, /PRP/);
});

test('la cancelacion a la profesional no lleva el telefono', () => {
  const t = textoCancelacion(turno, { tipo: 'profesional', profesionalNombre: 'Noemí' });
  assert.doesNotMatch(t, /1123456789/);
  assert.match(t, /15:00/);
});

test('la modificacion muestra el antes y el despues', () => {
  const nuevo = { ...turno, fecha: new Date('2026-11-20T00:00:00-03:00'), hora_inicio: '17:00' };
  const t = textoModificacion(turno, nuevo, { tipo: 'estudio', profesionalNombre: 'Noemí' });
  assert.match(t, /15:00/);
  assert.match(t, /17:00/);
  assert.match(t, /👩 Noemí/);
});

test('el grupo lista los servicios y el rango completo', () => {
  const segundo = { ...turno, hora_inicio: '16:30', hora_fin: '17:30', servicio: { nombre: 'Vitamina C' } };
  const t = textoNuevoTurnoGrupo([turno, segundo], { tipo: 'profesional', profesionalNombre: 'Noemí' });
  assert.match(t, /PRP/);
  assert.match(t, /Vitamina C/);
  assert.match(t, /15:00/);
  assert.match(t, /17:30/);
  assert.doesNotMatch(t, /1123456789/);
});
