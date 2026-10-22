// Cálculo de cuánto tiene que abonar una clienta al reservar.
//
// REGLA DE ORO: toda la plata se calcula acá, en el servidor, a partir de los
// precios de la base. Jamás se confía en un monto que llegue del frontend.
const prisma = require('./prisma');
const { validarTelefono, resolverExtras } = require('./reservas');

const CONFIG_ID = 1;

// `redondear` vive en lib/redondeo.js: lo comparten los montos de cobro y el
// cálculo de comisión. Se sigue re-exportando desde acá por compatibilidad.
const { redondear } = require('./redondeo');

// La config es una fila única. Si no existe la creamos con los defaults del
// schema, para que el cálculo nunca quede sin configuración con la que operar.
async function obtenerConfigPago() {
  const existente = await prisma.configPago.findUnique({ where: { id: CONFIG_ID } });
  if (existente) return existente;
  return prisma.configPago.create({ data: { id: CONFIG_ID } });
}

// ¿La clienta está marcada para abonar el 100% por adelantado?
async function requierePagoTotal(telefono) {
  const restriccion = await prisma.clienteRestriccion.findUnique({
    where: { cliente_telefono: telefono }
  });
  return !!(restriccion && restriccion.activo && restriccion.requiere_pago_total);
}

// Acepta las dos formas en que el frontend describe una reserva:
//   { servicio_id, extras }                        → turno simple
//   { servicios: [ { servicio_id, extras }, ... ] } → reserva múltiple
// Devuelve siempre un array normalizado.
function normalizarServicios({ servicio_id, extras, servicios }) {
  if (Array.isArray(servicios) && servicios.length > 0) {
    return servicios.map(item => (
      typeof item === 'object' && item !== null
        ? { servicio_id: parseInt(item.servicio_id), extras: item.extras }
        : { servicio_id: parseInt(item), extras: null }
    ));
  }
  if (servicio_id !== undefined && servicio_id !== null) {
    return [{ servicio_id: parseInt(servicio_id), extras }];
  }
  return [];
}

// Arma el detalle de precios de la reserva: cada servicio con sus extras válidos.
// Los extras de precio variable se listan aparte porque no se pueden cotizar.
async function armarDesglose(serviciosInput) {
  const desglose = [];
  let total = 0;
  let hayPrecioVariable = false;

  for (const item of serviciosInput) {
    if (isNaN(item.servicio_id)) {
      throw Object.assign(new Error('SERVICIO_INVALIDO'), { status: 400 });
    }

    const servicio = await prisma.servicio.findUnique({ where: { id: item.servicio_id } });
    if (!servicio || !servicio.activo) {
      throw Object.assign(new Error('SERVICIO_NO_ENCONTRADO'), { status: 404, servicioId: item.servicio_id });
    }

    const precioServicio = redondear(servicio.precio_pesos);
    total += precioServicio;
    desglose.push({
      tipo: 'servicio',
      servicio_id: servicio.id,
      nombre: servicio.nombre,
      precio: precioServicio
    });

    const extrasValidos = await resolverExtras(item.extras, servicio.id);
    for (const extra of extrasValidos) {
      if (extra.precio_variable) {
        // No se puede cotizar de antemano: no suma al monto, pero se muestra.
        hayPrecioVariable = true;
        desglose.push({
          tipo: 'extra',
          servicio_id: servicio.id,
          nombre: extra.nombre,
          precio: null,
          precio_variable: true,
          leyenda: 'a definir en el local'
        });
      } else {
        const precioExtra = redondear(extra.precio_pesos);
        total += precioExtra;
        desglose.push({
          tipo: 'extra',
          servicio_id: servicio.id,
          nombre: extra.nombre,
          precio: precioExtra,
          precio_variable: false
        });
      }
    }
  }

  return { desglose, total: redondear(total), hayPrecioVariable };
}

// ¿Alguno de los servicios es de una profesional que le cobra directo a la
// clienta? Se mira comision_pct_default: con valor, la plata es de ella y el
// estudio solo le liquida una comisión.
async function algunaProfesionalCobraAparte(serviciosInput) {
  // Se filtran los NaN antes de consultar: mover esta validacion arriba del
  // kill switch hizo que un servicio_id basura llegue hasta aca, y un
  // { in: [NaN] } hace explotar Prisma con un 500 donde antes habia un 400.
  // armarDesglose, mas abajo, es quien tira SERVICIO_INVALIDO como siempre.
  const ids = [...new Set(serviciosInput.map(s => s.servicio_id))].filter(n => !isNaN(n));
  if (ids.length === 0) return false;
  const servicios = await prisma.servicio.findMany({
    where: { id: { in: ids } },
    select: { profesional: { select: { comision_pct_default: true } } }
  });
  return servicios.some(s => s.profesional?.comision_pct_default != null);
}

// ── Cálculo principal ──────────────────────────
// Devuelve, para una reserva dada:
//   { requiere_pago, tipo, monto, total_servicios, saldo_local, desglose, ... }
//
// Reglas (decisiones de producto ya cerradas):
//  - cobro_activo = false → no se cobra nada, la reserva sigue el flujo de siempre.
//  - Clienta marcada con pago total → se cobra el 100% de TODOS los servicios del
//    bloque, extras incluidos.
//  - Resto → UNA sola seña de monto fijo por reserva, sin importar cuántos
//    servicios tenga el bloque.
async function calcularMonto({ telefono, servicio_id, extras, servicios }) {
  const config = await obtenerConfigPago();

  const serviciosInput = normalizarServicios({ servicio_id, extras, servicios });
  if (serviciosInput.length === 0) {
    throw Object.assign(new Error('SIN_SERVICIOS'), { status: 400 });
  }

  // Profesionales con comisión cobran ellas a la clienta: esa plata no es del
  // estudio, así que no puede entrar por el Mercado Pago del estudio. Va ANTES
  // del kill switch para que la respuesta sea la misma con el cobro prendido o
  // apagado, y no cambie el día que se active.
  if (await algunaProfesionalCobraAparte(serviciosInput)) {
    return { requiere_pago: false, motivo: 'profesional_sin_cobro_online' };
  }

  // Kill switch: con el cobro apagado, todo se comporta como antes de Mercado Pago.
  if (!config.cobro_activo) {
    return { requiere_pago: false, motivo: 'cobro_desactivado' };
  }

  const { desglose, total, hayPrecioVariable } = await armarDesglose(serviciosInput);

  // Sin nada cotizable (por ejemplo, todo de precio variable) no hay qué cobrar.
  if (total <= 0) {
    return {
      requiere_pago: false,
      motivo: 'sin_monto_cotizable',
      desglose,
      total_servicios: total,
      hay_precio_variable: hayPrecioVariable
    };
  }

  const telLimpio = validarTelefono(telefono);
  const pagoTotal = telLimpio ? await requierePagoTotal(telLimpio) : false;

  let tipo, monto;
  if (pagoTotal) {
    tipo = 'total';
    monto = total;
  } else {
    tipo = 'sena';
    // Nunca cobrar por adelantado más de lo que sale el servicio: si la seña
    // configurada supera el total de la reserva, se cobra el total.
    monto = Math.min(redondear(config.sena_monto), total);
  }

  return {
    requiere_pago: true,
    tipo,
    monto: redondear(monto),
    total_servicios: total,
    saldo_local: redondear(total - monto),
    desglose,
    hay_precio_variable: hayPrecioVariable,
    nota: hayPrecioVariable
      ? 'Los adicionales de precio variable se abonan en el local.'
      : null,
    texto_checkout: config.texto_checkout,
    hold_minutos: config.hold_minutos
  };
}

module.exports = {
  redondear,
  calcularMonto,
  obtenerConfigPago,
  requierePagoTotal,
  normalizarServicios,
  armarDesglose
};
