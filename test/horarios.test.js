const test = require('node:test');
const assert = require('node:assert/strict');

const { rangosQueAplican } = require('../lib/horarios');

// La consulta trae, para una fecha dada, los rangos semanales de ese dia de
// semana Y los de excepcion de esa fecha puntual. Esta funcion decide cuales
// mandan: si hay excepcion, la excepcion REEMPLAZA al horario de siempre.

const semanal = (hora_inicio, hora_fin) => ({ fecha: null, hora_inicio, hora_fin });
const excepcion = (hora_inicio, hora_fin) => ({ fecha: new Date('2026-11-07'), hora_inicio, hora_fin });

test('sin excepciones, mandan los rangos semanales', () => {
  const filas = [semanal('10:00', '15:00')];
  assert.deepEqual(rangosQueAplican(filas), filas);
});

test('con excepcion, la excepcion reemplaza al semanal', () => {
  const ex = excepcion('09:00', '20:00');
  const r = rangosQueAplican([semanal('10:00', '15:00'), ex]);
  assert.equal(r.length, 1);
  assert.equal(r[0].hora_inicio, '09:00');
  assert.equal(r[0].hora_fin, '20:00');
});

// El caso que motivo todo: el sabado normal es 10-15 y ese sabado es 9-20.
test('la excepcion puede ser mas larga que el horario de siempre', () => {
  const r = rangosQueAplican([semanal('10:00', '15:00'), excepcion('09:00', '20:00')]);
  assert.equal(r[0].hora_inicio, '09:00');
});

// Y el inverso, que con "reemplaza" sale gratis: acortar sin necesitar bloqueo.
test('la excepcion puede ser mas corta que el horario de siempre', () => {
  const r = rangosQueAplican([semanal('10:00', '15:00'), excepcion('11:00', '13:00')]);
  assert.equal(r.length, 1);
  assert.equal(r[0].hora_inicio, '11:00');
  assert.equal(r[0].hora_fin, '13:00');
});

test('una fecha puede tener varias franjas de excepcion', () => {
  const r = rangosQueAplican([
    semanal('10:00', '15:00'),
    excepcion('09:00', '13:00'),
    excepcion('16:00', '20:00')
  ]);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map(x => x.hora_inicio), ['09:00', '16:00']);
});

// Abrir un dia que normalmente esta cerrado: no hay fila semanal, solo la
// excepcion. Hoy esto es imposible.
test('una excepcion sola abre un dia que normalmente esta cerrado', () => {
  const r = rangosQueAplican([excepcion('10:00', '14:00')]);
  assert.equal(r.length, 1);
  assert.equal(r[0].hora_inicio, '10:00');
});

test('sin ninguna fila, no hay horarios', () => {
  assert.deepEqual(rangosQueAplican([]), []);
});

test('tolera que no le pasen nada', () => {
  assert.deepEqual(rangosQueAplican(undefined), []);
  assert.deepEqual(rangosQueAplican(null), []);
});
