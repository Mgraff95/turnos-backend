const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluarConflictoCruzado, mensajeDeConflicto } = require('../lib/camilla');

// Dos reglas que CRUZAN agendas, o sea que no las resuelve el chequeo de
// solapamiento de una sola profesional:
//
//  1. La camilla. Hay una sola en el estudio. Un servicio que la usa no puede
//     solaparse con otro que la usa, aunque sean de profesionales distintas.
//     Las unas no la usan: esas siguen corriendo en paralelo.
//
//  2. La clienta. No puede estar en dos sillas a la vez, asi que no puede tener
//     dos turnos solapados con profesionales distintas.

const maria = { cliente_telefono: '1123456789', cliente_nombre: 'María', cliente_apellido: 'Gómez' };

// Un turno de OTRA profesional que se solapa con lo que se esta reservando.
const turnoAjeno = (extra = {}) => ({
  hora_inicio: '10:00',
  hora_fin: '11:00',
  cliente_telefono: '1199887766',
  cliente_nombre: 'Ana',
  cliente_apellido: 'Pérez',
  servicio: { nombre: 'Hydralips', usa_camilla: true },
  profesional: { nombre: 'Elsa' },
  ...extra
});

test('sin turnos de otra profesional no hay nada que chequear', () => {
  const r = evaluarConflictoCruzado({ turnosAjenos: [], usaCamilla: true, cliente: maria });
  assert.equal(r, null);
});

// EL CASO del pedido: las unas no usan la camilla, siguen en paralelo.
test('un servicio que no usa la camilla no se bloquea por uno que si', () => {
  const r = evaluarConflictoCruzado({
    turnosAjenos: [turnoAjeno()],
    usaCamilla: false,
    cliente: maria
  });
  assert.equal(r, null);
});

test('dos servicios de camilla no pueden solaparse aunque sean de distintas profesionales', () => {
  const r = evaluarConflictoCruzado({
    turnosAjenos: [turnoAjeno()],
    usaCamilla: true,
    cliente: maria
  });
  assert.equal(r.codigo, 'CAMILLA_OCUPADA');
});

// La otra mitad de la regla: un turno ajeno de unas NO ocupa la camilla.
test('un servicio de camilla no se bloquea por un turno ajeno que no la usa', () => {
  const unas = turnoAjeno({ servicio: { nombre: 'Esmaltado', usa_camilla: false } });
  const r = evaluarConflictoCruzado({ turnosAjenos: [unas], usaCamilla: true, cliente: maria });
  assert.equal(r, null);
});

test('la misma persona no puede tener dos turnos solapados con distintas profesionales', () => {
  const suyo = turnoAjeno({ ...maria, servicio: { nombre: 'Esmaltado', usa_camilla: false } });
  const r = evaluarConflictoCruzado({ turnosAjenos: [suyo], usaCamilla: false, cliente: maria });
  assert.equal(r.codigo, 'MISMA_PERSONA');
});

// Cuando las dos reglas aplican, la que explica mejor es la de la persona.
test('si el turno que choca es de ella misma, ese es el motivo que gana', () => {
  const suyo = turnoAjeno({ ...maria });
  const r = evaluarConflictoCruzado({ turnosAjenos: [suyo], usaCamilla: true, cliente: maria });
  assert.equal(r.codigo, 'MISMA_PERSONA');
});

test('la mama no queda bloqueada por el turno de la hija, pero la camilla si', () => {
  const hija = turnoAjeno({ cliente_telefono: '1123456789', cliente_nombre: 'Lucía', cliente_apellido: 'Gómez' });
  // Mismo telefono, otra persona: no es "ya tenes un turno".
  assert.equal(
    evaluarConflictoCruzado({ turnosAjenos: [hija], usaCamilla: false, cliente: maria }),
    null
  );
  // Pero la camilla es una sola igual.
  assert.equal(
    evaluarConflictoCruzado({ turnosAjenos: [hija], usaCamilla: true, cliente: maria }).codigo,
    'CAMILLA_OCUPADA'
  );
});

test('sin cliente solo se evalua la camilla', () => {
  const r = evaluarConflictoCruzado({ turnosAjenos: [turnoAjeno()], usaCamilla: true });
  assert.equal(r.codigo, 'CAMILLA_OCUPADA');
});

// ── Mensajes ───────────────────────────────────
//
// La clienta tiene que entender QUE mover, asi que el mensaje nombra el turno
// que choca cuando es suyo.

test('el mensaje de la misma persona nombra el turno que tiene que mover', () => {
  const suyo = turnoAjeno({ ...maria });
  const msg = mensajeDeConflicto(evaluarConflictoCruzado({ turnosAjenos: [suyo], usaCamilla: true, cliente: maria }));
  assert.match(msg, /Hydralips/);
  assert.match(msg, /Elsa/);
  assert.match(msg, /10:00/);
  assert.match(msg, /11:00/);
});

// El turno de la camilla es de OTRA clienta: el mensaje no puede contar nada de ella.
test('el mensaje de la camilla no revela datos de la otra clienta', () => {
  const msg = mensajeDeConflicto({ codigo: 'CAMILLA_OCUPADA', turno: turnoAjeno() });
  assert.match(msg, /camilla/i);
  assert.match(msg, /10:00/);
  assert.doesNotMatch(msg, /Ana|Pérez|Hydralips|Elsa/);
});

test('el mensaje aguanta un turno sin servicio ni profesional cargados', () => {
  const pelado = { hora_inicio: '10:00', hora_fin: '11:00' };
  const msg = mensajeDeConflicto({ codigo: 'MISMA_PERSONA', turno: pelado });
  assert.match(msg, /10:00/);
  assert.ok(!msg.includes('undefined'));
});
