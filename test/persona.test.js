const test = require('node:test');
const assert = require('node:assert/strict');

const { esLaMismaPersona, normalizarNombre } = require('../lib/persona');

// Una misma persona no puede tener dos turnos solapados, aunque sean con
// profesionales distintas: es una sola y no puede estar en los dos lugares.
//
// Identidad = telefono + nombre + apellido. Solo el telefono no alcanza: en un
// estudio de belleza una mama reserva para ella y para su hija desde el mismo
// numero, y eso es legitimo.

const maria = { cliente_telefono: '1123456789', cliente_nombre: 'María', cliente_apellido: 'Gómez' };

test('la misma persona es la misma persona', () => {
  assert.equal(esLaMismaPersona(maria, { ...maria }), true);
});

// EL CASO que justifica no usar solo el telefono.
test('mama e hija comparten telefono pero no son la misma', () => {
  const lucia = { cliente_telefono: '1123456789', cliente_nombre: 'Lucía', cliente_apellido: 'Gómez' };
  assert.equal(esLaMismaPersona(maria, lucia), false);
});

test('distinto telefono, distinta persona aunque se llamen igual', () => {
  const otra = { ...maria, cliente_telefono: '1198765432' };
  assert.equal(esLaMismaPersona(maria, otra), false);
});

test('no se escapa por mayusculas ni espacios de mas', () => {
  const igual = { cliente_telefono: '1123456789', cliente_nombre: '  maría ', cliente_apellido: 'GÓMEZ' };
  assert.equal(esLaMismaPersona(maria, igual), true);
});

test('no se escapa por acentos', () => {
  const sinAcento = { cliente_telefono: '1123456789', cliente_nombre: 'Maria', cliente_apellido: 'Gomez' };
  assert.equal(esLaMismaPersona(maria, sinAcento), true);
});

test('no se escapa por el formato del telefono', () => {
  const conGuiones = { ...maria, cliente_telefono: '11-2345-6789' };
  assert.equal(esLaMismaPersona(maria, conGuiones), true);
});

test('normalizarNombre deja una forma comparable', () => {
  assert.equal(normalizarNombre('  María  José '), 'maria jose');
  assert.equal(normalizarNombre('GÓMEZ'), 'gomez');
  assert.equal(normalizarNombre(null), '');
});
