const test = require('node:test');
const assert = require('node:assert/strict');

const { tramosDeCamilla } = require('../lib/availability');

// Un bloque de varios servicios puede mezclar: facial (camilla) mas unas. La
// camilla hace falta solo en el tramo del facial, asi que medir el bloque
// ENTERO contra la otra agenda le esconderia a la clienta horarios que la
// transaccion igual acepta — y las unas en paralelo son justo lo que no hay que
// romper.
//
// tramosDeCamilla dice en que minutos del bloque se necesita la cama, contando
// desde el arranque del bloque.

const servicio = (id, nombre, usaCamilla, extra = {}) => ({
  id, nombre, usa_camilla: usaCamilla,
  intercalable: false, servicios_compatibles: [], intercalar_desde_min: 0, max_simultaneos: 2,
  ...extra
});

const item = (srv, duracion) => ({ servicio: srv, extras: [], duracion });

const FACIAL = servicio(1, 'Limpieza facial', true);
const UNAS = servicio(2, 'Esmaltado', false);

test('sin items no hay tramos', () => {
  assert.deepEqual(tramosDeCamilla([]), []);
  assert.deepEqual(tramosDeCamilla(undefined), []);
});

test('un servicio que no usa la camilla no genera tramos', () => {
  assert.deepEqual(tramosDeCamilla([item(UNAS, 60)]), []);
});

test('un solo servicio de camilla ocupa todo el bloque', () => {
  assert.deepEqual(tramosDeCamilla([item(FACIAL, 60)]), [{ desde: 0, hasta: 60 }]);
});

// EL CASO que motiva todo esto.
test('en un bloque mixto la camilla se necesita solo en su tramo', () => {
  const tramos = tramosDeCamilla([item(FACIAL, 60), item(UNAS, 60)]);
  assert.deepEqual(tramos, [{ desde: 0, hasta: 60 }]);
  // O sea: un turno de camilla ajeno en la segunda hora NO tiene por que
  // tapar el arranque del bloque.
});

test('y si las unas van primero, el tramo arranca despues', () => {
  const tramos = tramosDeCamilla([item(UNAS, 30), item(FACIAL, 60)]);
  assert.deepEqual(tramos, [{ desde: 30, hasta: 90 }]);
});

test('dos servicios de camilla seguidos dan dos tramos pegados', () => {
  const otro = servicio(3, 'PRP', true);
  assert.deepEqual(
    tramosDeCamilla([item(FACIAL, 60), item(otro, 30)]),
    [{ desde: 0, hasta: 60 }, { desde: 60, hasta: 90 }]
  );
});

// Un intercalado comparte el horario de su ancla, no se encadena atras.
test('un intercalado de camilla arranca en el offset de su ancla', () => {
  const ancla = servicio(1, 'PRP', true, {
    intercalable: true, servicios_compatibles: [4], intercalar_desde_min: 20
  });
  const pies = servicio(4, 'Pies', true);
  // El ancla dura 90 y el intercalado arranca en su minuto 20.
  assert.deepEqual(
    tramosDeCamilla([item(ancla, 90), item(pies, 40)]),
    [{ desde: 0, hasta: 90 }, { desde: 20, hasta: 60 }]
  );
});

test('un intercalado que no usa la camilla no aporta tramo', () => {
  const ancla = servicio(1, 'PRP', true, {
    intercalable: true, servicios_compatibles: [2], intercalar_desde_min: 20
  });
  assert.deepEqual(
    tramosDeCamilla([item(ancla, 90), item(UNAS, 30)]),
    [{ desde: 0, hasta: 90 }]
  );
});
