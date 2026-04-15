const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { authAdmin } = require('../middleware/auth');

// ── Validar teléfono argentino ─────────────────
function validarTelefono(tel) {
  const limpio = tel.replace(/\D/g, '');
  return /^\d{10}$/.test(limpio) ? limpio : null;
}

// ── POST /api/waitlist → Registrarse en waitlist ──
router.post('/', async (req, res, next) => {
  try {
    const { nombre, apellido, telefono, servicio_id, fecha, franja } = req.body;

    if (!nombre || !apellido || !telefono || !servicio_id || !fecha || !franja) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    if (!['manana', 'tarde'].includes(franja)) {
      return res.status(400).json({ error: 'Franja inválida. Usar: manana o tarde' });
    }

    const telLimpio = validarTelefono(telefono);
    if (!telLimpio) {
      return res.status(400).json({ error: 'Teléfono inválido. Ingresá 10 dígitos' });
    }

    const servicio = await prisma.servicio.findUnique({ where: { id: parseInt(servicio_id) } });
    if (!servicio || !servicio.activo) {
      return res.status(404).json({ error: 'Servicio no encontrado' });
    }

    // Verificar si ya está en waitlist para esa fecha y franja
    const yaExiste = await prisma.waitlist.findFirst({
      where: {
        cliente_telefono: telLimpio,
        fecha: new Date(fecha),
        franja,
        activo: true
      }
    });

    if (yaExiste) {
      return res.status(409).json({ error: 'Ya estás en la lista de espera para esa fecha y franja' });
    }

    const entrada = await prisma.waitlist.create({
      data: {
        cliente_nombre: nombre.trim(),
        cliente_apellido: apellido.trim(),
        cliente_telefono: telLimpio,
        servicio_id: parseInt(servicio_id),
        fecha: new Date(fecha),
        franja
      },
      include: { servicio: true }
    });

    res.status(201).json({ success: true, waitlist: entrada });
  } catch (err) { next(err); }
});

// ── GET /api/waitlist/admin → Ver waitlist (admin) ──
router.get('/admin', authAdmin, async (req, res, next) => {
  try {
    const hoy = new Date();
    const entries = await prisma.waitlist.findMany({
      where: {
        activo: true,
        fecha: { gte: hoy }
      },
      include: { servicio: true },
      orderBy: [{ fecha: 'asc' }, { created_at: 'asc' }]
    });
    res.json(entries);
  } catch (err) { next(err); }
});

// ── DELETE /api/waitlist/:id → Eliminar entrada (admin) ──
router.delete('/:id', authAdmin, async (req, res, next) => {
  try {
    await prisma.waitlist.update({
      where: { id: parseInt(req.params.id) },
      data: { activo: false }
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;