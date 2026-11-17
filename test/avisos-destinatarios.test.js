const test = require('node:test');
const assert = require('node:assert/strict');

const { destinatarios, normalizarTelefono } = require('../lib/avisos');

// La regla de quién recibe cada aviso. Vive separada del envío porque es la
// parte que se puede equivocar en silencio: un número repetido manda todo dos
// veces, y una profesional sin teléfono no tiene que frenar el aviso al estudio.

const noemi = { nombre: 'Noemí', telefono: '1198765432' };
const daniela = { nombre: 'Daniela', telefono: '11 2345-6789' };
const ESTUDIO = '1123456789';

test('el estudio y la profesional reciben, en ese orden', () => {
  const d = destinatarios({ telefonoEstudio: ESTUDIO, profesional: noemi });
  assert.deepEqual(d.map(x => [x.telefono, x.tipo]), [
    [ESTUDIO, 'estudio'],
    ['1198765432', 'profesional']
  ]);
  assert.equal(d[0].profesionalNombre, 'Noemí');
});

test('el turno de Daniela sale una sola vez, aunque el numero este escrito distinto', () => {
  const d = destinatarios({ telefonoEstudio: ESTUDIO, profesional: daniela });
  assert.equal(d.length, 1);
  assert.equal(d[0].tipo, 'estudio');
});

test('una profesional sin telefono no frena el aviso al estudio', () => {
  const d = destinatarios({ telefonoEstudio: ESTUDIO, profesional: { nombre: 'Noemí', telefono: null } });
  assert.deepEqual(d.map(x => x.tipo), ['estudio']);
});

test('sin DANIELA_TELEFONO la profesional igual recibe lo suyo', () => {
  const d = destinatarios({ telefonoEstudio: null, profesional: noemi });
  assert.deepEqual(d.map(x => x.tipo), ['profesional']);
});

test('el panel avisa solo a la profesional', () => {
  const d = destinatarios({ telefonoEstudio: ESTUDIO, profesional: noemi, incluirEstudio: false });
  assert.deepEqual(d.map(x => x.telefono), ['1198765432']);
});

test('un turno propio cargado desde el panel no manda nada', () => {
  assert.deepEqual(destinatarios({ telefonoEstudio: ESTUDIO, profesional: daniela, incluirEstudio: false }), []);
});

test('la profesional que no existe no rompe: solo el estudio', () => {
  const d = destinatarios({ telefonoEstudio: ESTUDIO, profesional: null });
  assert.deepEqual(d.map(x => x.tipo), ['estudio']);
  assert.equal(d[0].profesionalNombre, null);
});

test('normalizarTelefono deja solo digitos', () => {
  assert.equal(normalizarTelefono('11 2345-6789'), '1123456789');
  assert.equal(normalizarTelefono(''), null);
  assert.equal(normalizarTelefono(null), null);
});
