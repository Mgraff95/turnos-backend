const test = require('node:test');
const assert = require('node:assert/strict');

const { avisarNuevoTurno, avisarModificacion } = require('../lib/avisos');

// El fan-out: resolver la profesional del turno y mandar cada versión del
// mensaje a quien corresponde. Se prueba con un prisma y un transporte falsos
// porque lo que se puede romper acá no es el texto, es a quién le llega.

const ESTUDIO = '1123456789';
const turno = {
  profesional_id: 2,
  cliente_nombre: 'Carla', cliente_apellido: 'Giménez', cliente_telefono: '1155556666',
  fecha: new Date('2026-11-18T00:00:00-03:00'), hora_inicio: '15:00', hora_fin: '16:30',
  servicio: { nombre: 'PRP' }
};

function deps({ profesional = { nombre: 'Noemí', telefono: '1198765432' }, enviados = [] } = {}) {
  return {
    prisma: { profesional: { findUnique: async () => profesional } },
    enviar: async (telefono, mensaje) => { enviados.push({ telefono, mensaje }); return true; }
  };
}

test('un turno de otra profesional sale dos veces, con textos distintos', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  await avisarNuevoTurno(turno, { deps: deps({ enviados }) });
  assert.deepEqual(enviados.map(e => e.telefono), [ESTUDIO, '1198765432']);
  assert.match(enviados[0].mensaje, /👩 Noemí/);
  assert.doesNotMatch(enviados[1].mensaje, /1155556666/);
});

test('si la profesional no tiene telefono, sale solo el del estudio', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  await avisarNuevoTurno(turno, { deps: deps({ profesional: { nombre: 'Noemí', telefono: null }, enviados }) });
  assert.equal(enviados.length, 1);
});

test('una profesional borrada no tira: el estudio se entera igual', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  await avisarNuevoTurno(turno, { deps: deps({ profesional: null, enviados }) });
  assert.equal(enviados.length, 1);
  assert.match(enviados[0].mensaje, /PRP/);
});

test('el panel avisa solo a la profesional', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  await avisarNuevoTurno(turno, { incluirEstudio: false, deps: deps({ enviados }) });
  assert.deepEqual(enviados.map(e => e.telefono), ['1198765432']);
});

test('si cambia la profesional, una se entera de la baja y la otra del alta', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  const anterior = { ...turno, profesional_id: 2 };
  const nuevo = { ...turno, profesional_id: 3, servicio: { nombre: 'Esmaltado' } };
  const porId = { 2: { nombre: 'Noemí', telefono: '1198765432' }, 3: { nombre: 'Flor', telefono: '1177778888' } };
  await avisarModificacion(anterior, nuevo, {
    incluirEstudio: false,
    deps: {
      prisma: { profesional: { findUnique: async ({ where }) => porId[where.id] } },
      enviar: async (telefono, mensaje) => { enviados.push({ telefono, mensaje }); return true; }
    }
  });
  const porTelefono = Object.fromEntries(enviados.map(e => [e.telefono, e.mensaje]));
  assert.match(porTelefono['1198765432'], /cancel/i);
  assert.match(porTelefono['1177778888'], /agendaron|nuevo/i);
});

// Hallazgo del review de rama: el spec, el plan y el PENDIENTE dicen que una
// profesional sin teléfono "queda anotada en el log". No quedaba: se caía del
// fan-out en silencio, y el único modo de enterarse era que ella se queje. El
// camino de las agendas sí lo loguea; este no.
test('una profesional sin telefono queda anotada en el log', async () => {
  const lineas = [];
  const logOriginal = console.log;
  console.log = (...args) => lineas.push(args.join(' '));
  try {
    process.env.DANIELA_TELEFONO = ESTUDIO;
    await avisarNuevoTurno(turno, { deps: deps({ profesional: { nombre: 'Noemí', telefono: null } }) });
  } finally {
    console.log = logOriginal;
  }
  assert.ok(
    lineas.some(l => l.includes('Noemí') && l.includes('teléfono')),
    `no se logueó el descarte. Líneas: ${JSON.stringify(lineas)}`
  );
});

test('un turno de Daniela no se loguea como descarte', async () => {
  const lineas = [];
  const logOriginal = console.log;
  console.log = (...args) => lineas.push(args.join(' '));
  try {
    process.env.DANIELA_TELEFONO = ESTUDIO;
    await avisarNuevoTurno(turno, { deps: deps({ profesional: { nombre: 'Daniela', telefono: ESTUDIO } }) });
  } finally {
    console.log = logOriginal;
  }
  assert.deepEqual(lineas.filter(l => l.includes('teléfono')), []);
});
