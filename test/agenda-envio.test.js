const test = require('node:test');
const assert = require('node:assert/strict');

const { enviarAgendasDeManana } = require('../lib/avisos');

// Quién recibe qué agenda. Daniela recibe la del estudio —la completa, con las
// dos columnas— y nunca además la suya: sus turnos ya están ahí.

const ESTUDIO = '1123456789';
const dani = { id: 1, nombre: 'Daniela', orden: 0, telefono: ESTUDIO };
const noemi = { id: 2, nombre: 'Noemí', orden: 1, telefono: '1198765432' };
const t = (hora_inicio, hora_fin, profesional) => ({
  hora_inicio, hora_fin, profesional, profesional_id: profesional.id,
  servicio: { nombre: 'PRP' }, cliente_nombre: 'Ana', cliente_apellido: 'Gómez', cliente_telefono: '1155556666'
});

function deps(turnos, enviados) {
  return {
    prisma: { turno: { findMany: async () => turnos } },
    enviar: async (telefono, mensaje) => { enviados.push({ telefono, mensaje }); return true; }
  };
}

test('Daniela recibe la del estudio y Noemi la suya', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  await enviarAgendasDeManana(new Date('2026-11-18'), { deps: deps([t('10:00', '11:00', dani), t('15:00', '16:30', noemi)], enviados) });
  assert.deepEqual(enviados.map(e => e.telefono), [ESTUDIO, '1198765432']);
  assert.match(enviados[0].mensaje, /🏠 Estudio abierto de 10:00 a 16:30/);
  assert.doesNotMatch(enviados[1].mensaje, /Estudio abierto/);
});

test('Daniela no recibe dos mensajes por sus propios turnos', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  await enviarAgendasDeManana(new Date('2026-11-18'), { deps: deps([t('10:00', '11:00', dani)], enviados) });
  assert.equal(enviados.length, 1);
});

test('la profesional sin turnos manana no recibe nada', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  await enviarAgendasDeManana(new Date('2026-11-18'), { deps: deps([t('10:00', '11:00', dani)], enviados) });
  assert.deepEqual(enviados.map(e => e.telefono), [ESTUDIO]);
});

test('un dia vacio igual le llega a Daniela', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  await enviarAgendasDeManana(new Date('2026-11-18'), { deps: deps([], enviados) });
  assert.equal(enviados.length, 1);
});

test('la profesional sin telefono cargado no frena la del estudio', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  const sinTel = { ...noemi, telefono: null };
  await enviarAgendasDeManana(new Date('2026-11-18'), { deps: deps([t('15:00', '16:30', sinTel)], enviados) });
  assert.deepEqual(enviados.map(e => e.telefono), [ESTUDIO]);
});

// Mismo hallazgo, en el camino de las agendas.
test('la agenda sale a los digitos del telefono, no al formato cargado', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  const conGuiones = { ...noemi, telefono: '11 9876-5432' };
  await enviarAgendasDeManana(new Date('2026-11-18'), { deps: deps([t('15:00', '16:30', conGuiones)], enviados) });
  assert.deepEqual(enviados.map(e => e.telefono), [ESTUDIO, '1198765432']);
});
