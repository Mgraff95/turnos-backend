const test = require('node:test');
const assert = require('node:assert/strict');

const { avisarNuevoTurno } = require('../lib/avisos');

// Los avisos del panel van con incluirEstudio: false, porque el movimiento lo
// hizo Daniela y no tiene sentido avisarle de lo que acaba de hacer. El caso
// que hay que proteger es el suyo propio: un turno de Daniela cargado desde el
// panel no tiene que generar ningún mensaje, ni el de "te agendaron un turno".

const ESTUDIO = '1123456789';
const turnoDeDaniela = {
  profesional_id: 1,
  cliente_nombre: 'Ana', cliente_apellido: 'Pérez', cliente_telefono: '1155556666',
  fecha: new Date('2026-11-18T00:00:00-03:00'), hora_inicio: '10:00', hora_fin: '11:00',
  servicio: { nombre: 'Belleza de pies' }
};

test('un turno que Daniela se carga a si misma no manda ningun aviso', async () => {
  const enviados = [];
  process.env.DANIELA_TELEFONO = ESTUDIO;
  const n = await avisarNuevoTurno(turnoDeDaniela, {
    incluirEstudio: false,
    deps: {
      prisma: { profesional: { findUnique: async () => ({ nombre: 'Daniela', telefono: ESTUDIO }) } },
      enviar: async (telefono, mensaje) => { enviados.push({ telefono, mensaje }); return true; }
    }
  });
  assert.equal(n, 0);
  assert.equal(enviados.length, 0);
});
