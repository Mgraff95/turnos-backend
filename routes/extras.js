const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { authAdmin } = require('../middleware/auth');

// ── Admin: listar TODOS los extras (activos e inactivos) ──
router.get('/', async (req, res, next) => {
  try {
    const extras = await prisma.extra.findMany({
      orderBy: [{ destacado: 'desc' }, { nombre: 'asc' }]
    });
    res.json(extras);
  } catch (err) { next(err); }
});

// ── Público: extras activos ofrecidos para un servicio ──
router.get('/servicio/:servicioId', async (req, res, next) => {
  try {
    const servicioId = parseInt(req.params.servicioId);
    const extras = await prisma.extra.findMany({
      where: {
        activo: true,
        servicios_ids: { has: servicioId }
      },
      orderBy: [{ destacado: 'desc' }, { nombre: 'asc' }]
    });
    res.json(extras);
  } catch (err) { next(err); }
});

// ── Admin: crear extra ──────────────────────────
router.post('/', authAdmin, async (req, res, next) => {
  try {
    const { nombre, descripcion, precio_pesos, minutos_adicionales, servicios_ids, destacado } = req.body;

    if (!nombre || precio_pesos === undefined || precio_pesos === '') {
      return res.status(400).json({ error: 'Faltan campos: nombre, precio_pesos' });
    }

    const extra = await prisma.extra.create({
      data: {
        nombre: nombre.trim(),
        descripcion: descripcion ? descripcion.trim() : null,
        precio_pesos: parseFloat(precio_pesos),
        minutos_adicionales: parseInt(minutos_adicionales) || 0,
        servicios_ids: Array.isArray(servicios_ids) ? servicios_ids.map(n => parseInt(n)) : [],
        destacado: !!destacado
      }
    });
    res.status(201).json(extra);
  } catch (err) { next(err); }
});

// ── Admin: actualizar extra ─────────────────────
router.patch('/:id', authAdmin, async (req, res, next) => {
  try {
    const { nombre, descripcion, precio_pesos, minutos_adicionales, servicios_ids, destacado, activo } = req.body;

    const data = {};
    if (nombre !== undefined) data.nombre = nombre.trim();
    if (descripcion !== undefined) data.descripcion = descripcion ? descripcion.trim() : null;
    if (precio_pesos !== undefined && precio_pesos !== '') data.precio_pesos = parseFloat(precio_pesos);
    if (minutos_adicionales !== undefined) data.minutos_adicionales = parseInt(minutos_adicionales) || 0;
    if (servicios_ids !== undefined) data.servicios_ids = Array.isArray(servicios_ids) ? servicios_ids.map(n => parseInt(n)) : [];
    if (destacado !== undefined) data.destacado = !!destacado;
    if (activo !== undefined) data.activo = !!activo;

    const extra = await prisma.extra.update({
      where: { id: parseInt(req.params.id) },
      data
    });
    res.json(extra);
  } catch (err) { next(err); }
});

// ── Admin: desactivar extra (soft delete) ───────
router.delete('/:id', authAdmin, async (req, res, next) => {
  try {
    await prisma.extra.update({
      where: { id: parseInt(req.params.id) },
      data: { activo: false }
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
