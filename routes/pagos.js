const express = require('express');
const router = express.Router();
const { calcularMonto } = require('../lib/pagos');

// ── POST /api/pagos/cotizar → cuánto tiene que abonar la clienta ──
// Público. No crea nada: sirve para mostrarle el monto ANTES de mandarla a pagar.
//
// body: { telefono, servicio_id, extras }                          (turno simple)
//    o: { telefono, servicios: [ { servicio_id, extras }, ... ] }  (reserva múltiple)
//
// Respuesta con cobro activo:
//   { requiere_pago: true, tipo: 'sena'|'total', monto, total_servicios,
//     saldo_local, desglose[], hay_precio_variable, nota, texto_checkout, hold_minutos }
// Con el cobro apagado:
//   { requiere_pago: false, motivo: 'cobro_desactivado' }
router.post('/cotizar', async (req, res, next) => {
  try {
    const { telefono, servicio_id, extras, servicios } = req.body;

    const cotizacion = await calcularMonto({ telefono, servicio_id, extras, servicios });
    res.json(cotizacion);
  } catch (err) {
    if (err.message === 'SIN_SERVICIOS') {
      return res.status(400).json({ error: 'No se indicó ningún servicio' });
    }
    if (err.message === 'SERVICIO_INVALIDO') {
      return res.status(400).json({ error: 'Servicio inválido' });
    }
    if (err.message === 'SERVICIO_NO_ENCONTRADO') {
      return res.status(404).json({ error: 'Servicio no encontrado' });
    }
    next(err);
  }
});

module.exports = router;
