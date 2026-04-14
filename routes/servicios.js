const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { authAdmin } = require('../middleware/auth');

// ── Público: listar servicios activos ──────────
router.get('/', async (req, res, next) => {
  try {
    const servicios = await prisma.servicio.findMany({
      where: { activo: true },
      orderBy: { nombre: 'asc' }
    });
    res.json(servicios);
  } catch (err) { next(err); }
});

// ── Admin: crear servicio ──────────────────────
router.post('/', authAdmin, async (req, res, next) => {
  try {
    const { nombre, duracion_minutos, precio_pesos } = req.body;

    if (!nombre || !duracion_minutos || !precio_pesos) {
      return res.status(400).json({ error: 'Faltan campos: nombre, duracion_minutos, precio_pesos' });
    }

    const servicio = await prisma.servicio.create({
      data: {
        nombre,
        duracion_minutos: parseInt(duracion_minutos),
        precio_pesos: parseFloat(precio_pesos)
      }
    });
    res.status(201).json(servicio);
  } catch (err) { next(err); }
});

// ── Admin: actualizar servicio ─────────────────
router.patch('/:id', authAdmin, async (req, res, next) => {
  try {
    const servicio = await prisma.servicio.update({
      where: { id: parseInt(req.params.id) },
      data: req.body
    });
    res.json(servicio);
  } catch (err) { next(err); }
});

// ── Admin: desactivar servicio ─────────────────
router.delete('/:id', authAdmin, async (req, res, next) => {
  try {
    await prisma.servicio.update({
      where: { id: parseInt(req.params.id) },
      data: { activo: false }
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
