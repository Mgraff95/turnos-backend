const test = require('node:test');
const assert = require('node:assert/strict');

const { resolverProfesionalDeItems, calcularPrecioBase } = require('../lib/reservas');

test('devuelve la profesional cuando todos los servicios son de la misma', () => {
  const items = [
    { servicio: { id: 20, profesional_id: 2 } },
    { servicio: { id: 21, profesional_id: 2 } }
  ];
  assert.equal(resolverProfesionalDeItems(items), 2);
});

test('rechaza servicios de distintas profesionales', () => {
  const items = [
    { servicio: { id: 3, profesional_id: 1 } },
    { servicio: { id: 20, profesional_id: 2 } }
  ];
  assert.throws(
    () => resolverProfesionalDeItems(items),
    /SERVICIOS_DE_DISTINTAS_PROFESIONALES/
  );
});

test('un solo servicio devuelve su profesional', () => {
  assert.equal(resolverProfesionalDeItems([{ servicio: { id: 3, profesional_id: 1 } }]), 1);
});

test('el precio base suma el servicio y sus extras', () => {
  const precio = calcularPrecioBase(
    { precio_pesos: 50000 },
    [{ precio_pesos: 4000, precio_variable: false }]
  );
  assert.equal(precio, 54000);
});

// Mismo criterio que armarDesglose: un extra de precio variable se define en el
// local, asi que no se puede congelar ni cobrar comision sobre el.
test('el precio base ignora los extras de precio variable', () => {
  const precio = calcularPrecioBase(
    { precio_pesos: 50000 },
    [{ precio_pesos: 4000, precio_variable: true }]
  );
  assert.equal(precio, 50000);
});

test('el precio base sin extras es el del servicio', () => {
  assert.equal(calcularPrecioBase({ precio_pesos: 65000 }, []), 65000);
  assert.equal(calcularPrecioBase({ precio_pesos: 65000 }, undefined), 65000);
});
