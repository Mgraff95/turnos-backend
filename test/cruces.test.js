const test = require('node:test');
const assert = require('node:assert/strict');

const { chequearCruces } = require('../lib/availability');

// chequearCruces es la que DECIDE si un turno entra o no cuando el choque es
// con la otra agenda. lib/camilla.js decide con datos ya leidos; aca se prueba
// la otra mitad: que las consultas salgan con la forma correcta.
//
// Se prueba con una transaccion falsa porque solo toca tres metodos
// (servicio.findUnique, turno.findMany, reservaPendiente.findFirst). No hace
// falta base, y lo que se rompe en esta funcion son los filtros.

const DANIELA = 1;
const maria = { cliente_telefono: '1123456789', cliente_nombre: 'María', cliente_apellido: 'Gómez' };

function txFalsa({ usaCamilla, ajenos = [], hold = null, espia = {} }) {
  return {
    servicio: { findUnique: async () => ({ usa_camilla: usaCamilla }) },
    turno: {
      findMany: async (q) => { espia.whereTurnos = q.where; return ajenos; }
    },
    reservaPendiente: {
      findFirst: async (q) => {
        espia.whereHold = q.where;
        if (!hold) return null;
        // La falsa respeta el filtro por id, que es lo que se prueba mas abajo.
        if (q.where.id && q.where.id.not === hold.id) return null;
        return hold;
      }
    }
  };
}

const base = {
  fecha: new Date('2026-11-10'),
  horaInicio: '10:00',
  horaFin: '11:00',
  profesionalId: DANIELA,
  servicioId: 7,
  cliente: maria
};

const ajenoCamilla = {
  hora_inicio: '10:30', hora_fin: '11:30',
  cliente_telefono: '1199887766', cliente_nombre: 'Ana', cliente_apellido: 'Pérez',
  servicio: { nombre: 'Hydralips', usa_camilla: true },
  profesional: { nombre: 'Elsa' }
};

test('la consulta mira solo las OTRAS agendas, y con solapamiento', async () => {
  const espia = {};
  await chequearCruces(txFalsa({ usaCamilla: false, espia }), base);
  assert.deepEqual(espia.whereTurnos.profesional_id, { not: DANIELA });
  assert.equal(espia.whereTurnos.estado, 'confirmado');
  assert.equal(espia.whereTurnos.OR.length, 3);
  // En Prisma un `id: undefined` significa "sin filtro": es lo que se quiere
  // cuando no hay nada que excluir, pero conviene que quede dicho.
  assert.equal(espia.whereTurnos.id, undefined);
});

test('un servicio que no usa la camilla corre en paralelo con uno que si', async () => {
  await chequearCruces(txFalsa({ usaCamilla: false, ajenos: [ajenoCamilla] }), base);
});

test('un servicio de camilla no entra si la camilla esta ocupada', async () => {
  await assert.rejects(
    () => chequearCruces(txFalsa({ usaCamilla: true, ajenos: [ajenoCamilla] }), base),
    (e) => {
      assert.equal(e.message, 'CAMILLA_OCUPADA');
      assert.equal(e.status, 409);
      assert.match(e.publico, /camilla/);
      // El turno es de otra clienta: el mensaje no puede contar nada de ella.
      assert.doesNotMatch(e.publico, /Ana|Pérez|Hydralips/);
      return true;
    }
  );
});

test('la misma persona no puede tener dos turnos solapados, haya camilla o no', async () => {
  const suyo = { ...ajenoCamilla, ...maria, servicio: { nombre: 'Esmaltado', usa_camilla: false } };
  await assert.rejects(
    () => chequearCruces(txFalsa({ usaCamilla: false, ajenos: [suyo] }), base),
    (e) => {
      assert.equal(e.message, 'MISMA_PERSONA');
      assert.match(e.publico, /Esmaltado/);
      assert.match(e.publico, /Elsa/);
      return true;
    }
  );
});

test('sin datos de la clienta falla ruidoso en vez de dejar pasar', async () => {
  await assert.rejects(
    () => chequearCruces(txFalsa({ usaCamilla: true }), { ...base, cliente: undefined }),
    (e) => e.message === 'CLIENTE_REQUERIDO'
  );
});

test('al mover un turno no se choca consigo mismo', async () => {
  const espia = {};
  await chequearCruces(txFalsa({ usaCamilla: true, espia }), { ...base, ignorarTurnoIds: [42] });
  assert.deepEqual(espia.whereTurnos.id, { notIn: [42] });
});

// ── El hold del pago en curso ──────────────────

test('un hold de camilla de otra profesional congela la camilla', async () => {
  await assert.rejects(
    () => chequearCruces(
      txFalsa({ usaCamilla: true, hold: { id: 7, hora_inicio: '10:00', hora_fin: '11:00' } }),
      base
    ),
    (e) => e.message === 'CAMILLA_OCUPADA'
  );
});

// EL QUE IMPORTA.
//
// Cuando el webhook crea el turno de un pago aprobado, el hold de ESE pago
// todavia esta `activa` (se cierra despues de crear los turnos) y lleva
// usa_camilla en true sobre el mismo rango. Sin excluirlo, se bloquea a si
// mismo: la clienta paga, no se le crea el turno, y queda mirando una pantalla
// de "procesando" hasta que el hold expire.
//
// Pasa con TODO servicio de camilla pagado online, no es un borde.
test('el hold del propio pago no se bloquea a si mismo', async () => {
  const espia = {};
  await chequearCruces(
    txFalsa({ usaCamilla: true, hold: { id: 7, hora_inicio: '10:00', hora_fin: '11:00' }, espia }),
    { ...base, ignorarHoldId: 7 }
  );
  assert.deepEqual(espia.whereHold.id, { not: 7 });
});
