// Resuelve cuánta comisión le corresponde al estudio por un turno.
//
// Vive acá y no dentro de lib/reservas.js para que sea lógica pura y testeable
// sola: no toca la base, recibe los objetos ya cargados.
//
// El resultado se CONGELA en el turno al crearlo (precio_base, comision_pct,
// comision_monto). Esa es la razón de ser de esta función: si la comisión se
// recalculara en vivo, cambiar el precio de un servicio alteraría una
// liquidación que ya se le compartió a la profesional.
// Desde lib/redondeo.js y no desde lib/pagos.js: pagos requiere reservas, y
// reservas requiere este módulo, así que tomarlo de pagos armaría un ciclo.
const { redondear } = require('./redondeo');

// pct del servicio, y si no tiene, el de la profesional.
// null = esa profesional es el estudio: no hay nada que liquidar.
//
// `??` y no `||` a propósito: distingue "el servicio no tiene excepción"
// (null, hay que heredar) de "el servicio tiene 0% de comisión" (0, válido
// y no se hereda).
function resolverComision(servicio, profesional, precioBase) {
  const pct = servicio.comision_pct ?? profesional.comision_pct_default;
  if (pct == null) return { comision_pct: null, comision_monto: null };

  return {
    comision_pct: Number(pct),
    comision_monto: redondear(Number(precioBase) * (Number(pct) / 100))
  };
}

// Valida un porcentaje de comisión que viene del panel.
//
// Devuelve el número, o null para "sin comisión" (vacío, null, undefined).
// Lanza COMISION_INVALIDA si no es un número entre 0 y 100: sin esta
// validación, un 300 tipeado de más hace que la liquidación le pida a la
// profesional el triple de lo que facturó.
function validarPct(valor) {
  if (valor === null || valor === undefined || valor === '') return null;

  const n = Number(valor);
  if (typeof valor === 'object' || !Number.isFinite(n) || n < 0 || n > 100) {
    throw Object.assign(new Error('COMISION_INVALIDA'), {
      status: 400,
      publico: 'La comisión debe ser un número entre 0 y 100'
    });
  }
  return n;
}

module.exports = { resolverComision, validarPct };
