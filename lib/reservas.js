// Helpers compartidos entre las rutas que arman una reserva.
// Viven acá para que la cotización (/api/pagos) y la creación del turno
// (/api/turnos, /api/admin/turnos) resuelvan exactamente lo mismo: si divergen,
// se cobra un monto y se reserva otro.
const { v4: uuidv4 } = require('uuid');
const prisma = require('./prisma');
const { redondear } = require('./redondeo');
const { resolverComision } = require('./comisiones');
const {
  calcularHoraFin,
  resolverBloqueConIntercalados,
  horaAMinutos,
  minutosAHora
} = require('./availability');

// ── Validar teléfono argentino (10 dígitos) ────
// Devuelve el teléfono normalizado, o null si no es válido.
function validarTelefono(tel) {
  if (!tel) return null;
  const limpio = String(tel).replace(/\D/g, '');
  return /^\d{10}$/.test(limpio) ? limpio : null;
}

// ── Resolver extras válidos para un servicio ───
// Devuelve solo los extras activos que efectivamente se ofrecen para ese servicio.
async function resolverExtras(extrasInput, servicioId) {
  if (!extrasInput) return [];
  const arr = Array.isArray(extrasInput)
    ? extrasInput
    : String(extrasInput).split(',');
  const ids = arr.map(n => parseInt(n)).filter(n => !isNaN(n));
  if (ids.length === 0) return [];
  return prisma.extra.findMany({
    where: {
      id: { in: ids },
      activo: true,
      servicios_ids: { has: servicioId }
    }
  });
}

// ── Profesional única por reserva ──────────────
//
// Una reserva es de una sola profesional. Si la clienta quiere un servicio de
// cada una, hace dos reservas: nada garantiza que las dos agendas tengan el
// mismo hueco libre, y prometerle un bloque que no existe es peor que pedirle
// que reserve dos veces.
//
// Pura a propósito: recibe los items ya resueltos y no toca la base, así se
// testea sola. Al vivir acá cubre los tres flujos que arman turnos (web, panel
// y pago), porque todos pasan por construirTurnosDeReserva.
function resolverProfesionalDeItems(items) {
  const ids = [...new Set(items.map(it => it.servicio.profesional_id))];
  if (ids.length > 1) {
    throw Object.assign(new Error('SERVICIOS_DE_DISTINTAS_PROFESIONALES'), {
      status: 400,
      publico: 'No se pueden combinar servicios de distintas profesionales en una misma reserva'
    });
  }
  return ids[0];
}

// Precio con el que se congela la plata de un turno.
//
// Mismo criterio que armarDesglose en lib/pagos.js: los extras de precio
// variable NO suman, porque su precio se define en el local y acá todavía no se
// conoce. Consecuencia a tener presente: la comisión de un turno con un extra
// variable no incluye ese extra.
function calcularPrecioBase(servicio, extras) {
  const sumaExtras = (extras || []).reduce(
    (s, e) => s + (e.precio_variable ? 0 : Number(e.precio_pesos)),
    0
  );
  return redondear(Number(servicio.precio_pesos) + sumaExtras);
}

// Resuelve, para los items de una reserva, la profesional y la plata congelada
// de cada servicio.
//
// Existe como helper compartido porque los turnos se crean en CINCO lugares
// distintos: POST /api/turnos, POST /api/turnos/multi, POST /api/admin/turnos,
// POST /api/admin/turnos/multi y el flujo de pago. Esa duplicación es anterior
// a este cambio y no se toca, pero la lógica nueva de profesional y comisión
// tiene que vivir en un solo lugar o va a divergir — y cuando divergen,
// se cobra una comisión y se liquida otra.
//
// Devuelve { profesionalId, plataPorServicioId } donde plataPorServicioId
// mapea servicio_id -> { precio_base, comision_pct, comision_monto }, listo
// para desparramar en el objeto del turno.
async function resolverProfesionalYPlata(items) {
  const profesionalId = resolverProfesionalDeItems(items);

  const profesional = await prisma.profesional.findUnique({ where: { id: profesionalId } });
  if (!profesional) {
    throw Object.assign(new Error('PROFESIONAL_NO_ENCONTRADA'), { status: 404 });
  }

  const plataPorServicioId = {};
  for (const it of items) {
    const precioBase = calcularPrecioBase(it.servicio, it.extras);
    plataPorServicioId[it.servicio.id] = {
      precio_base: precioBase,
      ...resolverComision(it.servicio, profesional, precioBase)
    };
  }

  return { profesionalId, plataPorServicioId };
}

// ── Construir los turnos de una reserva ────────
//
// Arma los objetos listos para crear, con la MISMA lógica que usan
// POST /api/turnos y POST /api/turnos/multi: encadenado de secuenciales,
// intercalación de compatibles, grupo_reserva y orden_en_grupo.
//
// Se usa en el flujo de pago. El checkout la llama una sola vez para saber qué
// rango tiene que ocupar el hold, guarda el resultado en el payload del hold, y
// el webhook crea exactamente esos turnos cuando el pago se aprueba. Al
// calcularse una única vez, no hay forma de que lo cobrado y lo reservado se
// separen.
//
// Devuelve { items, turnosData, rangoInicio, rangoFin, grupoReserva, esMulti }.
async function construirTurnosDeReserva({ nombre, apellido, telefono, fecha, hora_inicio, servicios, origen = 'web' }) {
  const telLimpio = validarTelefono(telefono);
  if (!telLimpio) throw Object.assign(new Error('TELEFONO_INVALIDO'), { status: 400 });

  const lista = Array.isArray(servicios) ? servicios : [];
  if (lista.length === 0) throw Object.assign(new Error('SIN_SERVICIOS'), { status: 400 });

  // Resolver cada servicio con sus extras, en el orden enviado
  const items = [];
  for (const item of lista) {
    const sid = parseInt(typeof item === 'object' ? item.servicio_id : item);
    if (isNaN(sid)) throw Object.assign(new Error('SERVICIO_INVALIDO'), { status: 400 });

    const servicio = await prisma.servicio.findUnique({ where: { id: sid } });
    if (!servicio || !servicio.activo) {
      throw Object.assign(new Error('SERVICIO_NO_ENCONTRADO'), { status: 404, servicioId: sid });
    }
    const extrasValidos = await resolverExtras(typeof item === 'object' ? item.extras : null, sid);
    const minutosExtra = extrasValidos.reduce((s, e) => s + (e.minutos_adicionales || 0), 0);
    items.push({ servicio, extras: extrasValidos, duracion: servicio.duracion_minutos + minutosExtra });
  }

  const { profesionalId, plataPorServicioId } = await resolverProfesionalYPlata(items);

  const tokenExpires = new Date();
  tokenExpires.setDate(tokenExpires.getDate() + 30);

  const base = {
    cliente_nombre: String(nombre).trim(),
    cliente_apellido: String(apellido).trim(),
    cliente_telefono: telLimpio,
    fecha: new Date(fecha),
    estado: 'confirmado',
    origen,
    profesional_id: profesionalId
  };

  // Precio y comisión son POR TURNO: cada uno tiene su propio servicio y sus
  // propios extras. La profesional, en cambio, la comparte toda la reserva.
  const plata = (item) => plataPorServicioId[item.servicio.id];

  // ── Turno simple ──
  if (items.length === 1) {
    const item = items[0];
    const horaFin = calcularHoraFin(hora_inicio, item.duracion);
    return {
      items,
      esMulti: false,
      profesionalId,
      grupoReserva: null,
      rangoInicio: hora_inicio,
      rangoFin: horaFin,
      turnosData: [{
        ...base,
        ...plata(item),
        servicio_id: item.servicio.id,
        hora_inicio,
        hora_fin: horaFin,
        extras_ids: item.extras.map(e => e.id),
        token_acceso: uuidv4(),
        token_expires_at: tokenExpires
      }]
    };
  }

  // ── Bloque de varios servicios ──
  const { secuenciales, intercalados, duracionEfectivaPorId } = resolverBloqueConIntercalados(items);

  const grupoReserva = uuidv4();
  let cursor = hora_inicio;
  let ordenGrupo = 0;
  const turnosData = [];
  const horarioPorServicioId = {};

  // 1. Encadenar los secuenciales (con la duración efectiva, que para un ancla
  //    ya viene estirada para cubrir al compatible que lleva adentro)
  secuenciales.forEach(item => {
    const inicio = cursor;
    const finReal = calcularHoraFin(inicio, item.duracion);
    const finEfectivo = calcularHoraFin(inicio, duracionEfectivaPorId[item.servicio.id]);
    horarioPorServicioId[item.servicio.id] = { inicio, fin: finEfectivo };
    ordenGrupo++;
    turnosData.push({
      ...base,
      ...plata(item),
      servicio_id: item.servicio.id,
      hora_inicio: inicio,
      hora_fin: finReal,
      extras_ids: item.extras.map(e => e.id),
      grupo_reserva: grupoReserva,
      orden_en_grupo: ordenGrupo,
      token_acceso: uuidv4(),
      token_expires_at: tokenExpires
    });
    cursor = finEfectivo;
  });

  // 2. Ubicar los intercalados: comparten el horario de su ancla
  intercalados.forEach(({ item, anclaServicioId, offsetMin }) => {
    const anclaHorario = horarioPorServicioId[anclaServicioId];
    const inicio = minutosAHora(horaAMinutos(anclaHorario.inicio) + offsetMin);
    const fin = calcularHoraFin(inicio, item.duracion);
    ordenGrupo++;
    turnosData.push({
      ...base,
      ...plata(item),
      servicio_id: item.servicio.id,
      hora_inicio: inicio,
      hora_fin: fin,
      extras_ids: item.extras.map(e => e.id),
      grupo_reserva: grupoReserva,
      orden_en_grupo: ordenGrupo,
      token_acceso: uuidv4(),
      token_expires_at: tokenExpires
    });
  });

  return {
    items,
    esMulti: true,
    profesionalId,
    grupoReserva,
    rangoInicio: hora_inicio,
    rangoFin: cursor, // los intercalados siempre terminan antes o igual
    turnosData
  };
}

// El payload del hold viaja por JSON, así que las fechas vuelven como string.
// Esto las devuelve a Date antes de crear los turnos.
function revivirTurnosData(turnosData) {
  return (turnosData || []).map(t => {
    const revivido = { ...t, fecha: new Date(t.fecha) };
    if (t.token_expires_at) revivido.token_expires_at = new Date(t.token_expires_at);
    return revivido;
  });
}

module.exports = {
  validarTelefono,
  resolverProfesionalDeItems,
  calcularPrecioBase,
  resolverProfesionalYPlata,
  resolverExtras,
  construirTurnosDeReserva,
  revivirTurnosData
};
