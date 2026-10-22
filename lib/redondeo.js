// Redondeo a 2 decimales, para no arrastrar basura de punto flotante en pesos.
//
// Vive en su propio módulo porque lo necesitan dos cadenas distintas:
// lib/pagos.js (montos de cobro) y lib/comisiones.js (comisión de un turno).
// Si comisiones lo tomara de pagos se armaría un ciclo, porque pagos requiere
// reservas y reservas requiere comisiones.
//
// Que sea una sola implementación no es cosmético: si la comisión redondeara
// distinto que el checkout, aparecerían diferencias de un peso entre lo que la
// clienta pagó y lo que dice la liquidación.
function redondear(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

module.exports = { redondear };
