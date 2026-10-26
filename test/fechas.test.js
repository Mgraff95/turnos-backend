const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ANTELACION_MINIMA_HORAS,
  instanteDelTurno,
  faltanMenosDe
} = require('../lib/fechas');

// El server corre en UTC y hora_inicio esta en hora argentina, asi que el
// instante del turno se arma forzando -03:00. Es el mismo patron que ya usa
// lib/scheduler.js:182, y el comentario de services/mercadopago.js avisa que
// construir fechas sin offset ya rompio algo antes.

test('instanteDelTurno interpreta la hora como argentina, no como UTC', () => {
  // Las 12:00 del 28/10 en Argentina son las 15:00 UTC.
  const i = instanteDelTurno('2026-10-28', '12:00');
  assert.equal(i.toISOString(), '2026-10-28T15:00:00.000Z');
});

test('instanteDelTurno acepta una fecha con hora pegada, como la devuelve Prisma', () => {
  const i = instanteDelTurno('2026-10-28T00:00:00.000Z', '09:30');
  assert.equal(i.toISOString(), '2026-10-28T12:30:00.000Z');
});

test('instanteDelTurno acepta un Date', () => {
  const i = instanteDelTurno(new Date('2026-10-28T00:00:00.000Z'), '18:00');
  assert.equal(i.toISOString(), '2026-10-28T21:00:00.000Z');
});

// ── La regla ──

test('un turno a 23 horas vista queda adentro de la ventana', () => {
  const ahora = new Date('2026-10-27T15:00:00.000Z'); // 12:00 ARG del 27
  // 11:00 ARG del 28 = 23 horas despues
  assert.equal(faltanMenosDe(24, '2026-10-28', '11:00', ahora), true);
});

test('un turno a 25 horas vista queda afuera de la ventana', () => {
  const ahora = new Date('2026-10-27T15:00:00.000Z'); // 12:00 ARG del 27
  // 13:00 ARG del 28 = 25 horas despues
  assert.equal(faltanMenosDe(24, '2026-10-28', '13:00', ahora), false);
});

test('el borde exacto de 24 horas NO queda adentro', () => {
  const ahora = new Date('2026-10-27T15:00:00.000Z'); // 12:00 ARG del 27
  // 12:00 ARG del 28 = exactamente 24 horas
  assert.equal(faltanMenosDe(24, '2026-10-28', '12:00', ahora), false);
});

// EL QUE IMPORTA.
//
// Si el borde se calculara en UTC en vez de en hora argentina, la ventana se
// correria tres horas y este caso daria el resultado opuesto.
test('el borde se calcula en hora argentina y no en UTC', () => {
  // 23:00 UTC del 27 son las 20:00 ARG del 27.
  const ahora = new Date('2026-10-27T23:00:00.000Z');
  // 19:00 ARG del 28 = 23 horas despues -> adentro
  assert.equal(faltanMenosDe(24, '2026-10-28', '19:00', ahora), true);
  // 21:00 ARG del 28 = 25 horas despues -> afuera
  assert.equal(faltanMenosDe(24, '2026-10-28', '21:00', ahora), false);
});

test('un turno en el pasado queda adentro de la ventana (o sea, se rechaza)', () => {
  const ahora = new Date('2026-10-27T15:00:00.000Z');
  assert.equal(faltanMenosDe(24, '2026-01-13', '09:00', ahora), true);
  assert.equal(faltanMenosDe(24, '2026-10-27', '09:00', ahora), true);
});

test('un turno a dos meses queda holgadamente afuera', () => {
  const ahora = new Date('2026-10-27T15:00:00.000Z');
  assert.equal(faltanMenosDe(24, '2026-12-27', '10:00', ahora), false);
});

test('la constante es 24', () => {
  assert.equal(ANTELACION_MINIMA_HORAS, 24);
});
