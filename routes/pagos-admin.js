const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { authAdmin } = require('../middleware/auth');
const { validarTelefono } = require('../lib/reservas');

// Límites de seguridad para la configuración de cobro (spec §6.8)
const SENA_MIN = 1;
const SENA_MAX = 200000;
const HOLD_MIN = 5;
const HOLD_MAX = 60;

// La config es una fila única (id = 1). Si todavía no existe (por ejemplo
// porque no se corrió el seed), la creamos con los defaults del schema en vez
// de devolver 404: así el panel nunca queda sin configuración con la que operar.
async function obtenerConfig() {
  const existente = await prisma.configPago.findUnique({ where: { id: 1 } });
  if (existente) return existente;
  return prisma.configPago.create({ data: { id: 1 } });
}

// Prisma devuelve Decimal; el panel necesita números planos.
function serializarConfig(c) {
  return {
    id: c.id,
    cobro_activo: c.cobro_activo,
    sena_monto: Number(c.sena_monto),
    hold_minutos: c.hold_minutos,
    texto_checkout: c.texto_checkout,
    updated_at: c.updated_at
  };
}

// ── GET /api/admin/config-pago → configuración actual ──
router.get('/config-pago', authAdmin, async (req, res, next) => {
  try {
    const config = await obtenerConfig();
    res.json(serializarConfig(config));
  } catch (err) { next(err); }
});

// ── PATCH /api/admin/config-pago → actualizar configuración ──
// body: { cobro_activo?, sena_monto?, hold_minutos?, texto_checkout? }
router.patch('/config-pago', authAdmin, async (req, res, next) => {
  try {
    const { cobro_activo, sena_monto, hold_minutos, texto_checkout } = req.body;
    const data = {};

    if (cobro_activo !== undefined) {
      if (typeof cobro_activo !== 'boolean') {
        return res.status(400).json({ error: 'cobro_activo debe ser true o false' });
      }
      data.cobro_activo = cobro_activo;
    }

    if (sena_monto !== undefined) {
      const monto = Number(sena_monto);
      if (!Number.isFinite(monto) || monto < SENA_MIN || monto > SENA_MAX) {
        return res.status(400).json({
          error: `El monto de la seña debe estar entre $${SENA_MIN} y $${SENA_MAX}`
        });
      }
      data.sena_monto = monto;
    }

    if (hold_minutos !== undefined) {
      const minutos = parseInt(hold_minutos);
      if (isNaN(minutos) || minutos < HOLD_MIN || minutos > HOLD_MAX) {
        return res.status(400).json({
          error: `El tiempo de reserva debe estar entre ${HOLD_MIN} y ${HOLD_MAX} minutos`
        });
      }
      data.hold_minutos = minutos;
    }

    if (texto_checkout !== undefined) {
      data.texto_checkout = texto_checkout === null || texto_checkout.trim() === ''
        ? null
        : texto_checkout.trim();
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'No se enviaron campos para actualizar' });
    }

    // Aseguramos que la fila exista antes de actualizarla.
    await obtenerConfig();
    const config = await prisma.configPago.update({ where: { id: 1 }, data });

    res.json(serializarConfig(config));
  } catch (err) { next(err); }
});

// ── GET /api/admin/restricciones → clientas con pago total anticipado ──
// ?incluir_inactivas=true para ver también las que Daniela dio de baja.
router.get('/restricciones', authAdmin, async (req, res, next) => {
  try {
    const incluirInactivas = req.query.incluir_inactivas === 'true';
    const where = incluirInactivas ? {} : { activo: true };

    const restricciones = await prisma.clienteRestriccion.findMany({
      where,
      orderBy: { updated_at: 'desc' }
    });

    res.json(restricciones);
  } catch (err) { next(err); }
});

// ── GET /api/admin/restricciones/:telefono → estado de una clienta puntual ──
// Lo usa la ficha de clienta para pintar el toggle. Devuelve null (200) si no
// tiene restricción, para que el panel no tenga que tratar un 404 como caso normal.
router.get('/restricciones/:telefono', authAdmin, async (req, res, next) => {
  try {
    const telefono = validarTelefono(req.params.telefono);
    if (!telefono) {
      return res.status(400).json({ error: 'Teléfono inválido (debe tener 10 dígitos)' });
    }

    const restriccion = await prisma.clienteRestriccion.findUnique({
      where: { cliente_telefono: telefono }
    });

    res.json(restriccion && restriccion.activo ? restriccion : null);
  } catch (err) { next(err); }
});

// ── POST /api/admin/restricciones → marcar clienta con pago total ──
// body: { telefono, nombre?, apellido?, motivo? }
// Es un upsert: si la clienta ya había sido marcada y dada de baja, se reactiva
// con el motivo nuevo en lugar de fallar por el unique de cliente_telefono.
router.post('/restricciones', authAdmin, async (req, res, next) => {
  try {
    const { telefono, nombre, apellido, motivo } = req.body;

    const telLimpio = validarTelefono(telefono);
    if (!telLimpio) {
      return res.status(400).json({ error: 'Teléfono inválido (debe tener 10 dígitos)' });
    }

    const motivoLimpio = motivo && motivo.trim() ? motivo.trim() : null;
    const nombreLimpio = nombre && nombre.trim() ? nombre.trim() : null;
    const apellidoLimpio = apellido && apellido.trim() ? apellido.trim() : null;

    const restriccion = await prisma.clienteRestriccion.upsert({
      where: { cliente_telefono: telLimpio },
      create: {
        cliente_telefono: telLimpio,
        cliente_nombre: nombreLimpio,
        cliente_apellido: apellidoLimpio,
        motivo: motivoLimpio,
        requiere_pago_total: true,
        activo: true
      },
      update: {
        // Si vienen datos nuevos los pisamos; si no, conservamos el snapshot previo.
        ...(nombreLimpio ? { cliente_nombre: nombreLimpio } : {}),
        ...(apellidoLimpio ? { cliente_apellido: apellidoLimpio } : {}),
        motivo: motivoLimpio,
        requiere_pago_total: true,
        activo: true
      }
    });

    res.status(201).json(restriccion);
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/restricciones/:telefono → sacar a la clienta de la lista ──
// Baja lógica (activo = false): conserva el motivo y la fecha para que Daniela
// pueda ver el historial si la clienta reincide.
router.delete('/restricciones/:telefono', authAdmin, async (req, res, next) => {
  try {
    const telefono = validarTelefono(req.params.telefono);
    if (!telefono) {
      return res.status(400).json({ error: 'Teléfono inválido (debe tener 10 dígitos)' });
    }

    const existente = await prisma.clienteRestriccion.findUnique({
      where: { cliente_telefono: telefono }
    });
    if (!existente) {
      return res.status(404).json({ error: 'Esa clienta no está en la lista' });
    }

    await prisma.clienteRestriccion.update({
      where: { cliente_telefono: telefono },
      data: { activo: false }
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
