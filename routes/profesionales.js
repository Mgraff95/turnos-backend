const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { authAdmin } = require('../middleware/auth');
const { validarPct } = require('../lib/comisiones');

// Van a ser dos o tres filas, así que no hay paginado ni búsqueda a propósito.

// ── Público: listar profesionales activas ──────
// Público porque la web de reservas agrupa los servicios por profesional y
// necesita el nombre. No expone comision_pct_default: el reparto de plata es
// información interna.
router.get('/', async (req, res, next) => {
  try {
    const profesionales = await prisma.profesional.findMany({
      where: { activo: true },
      select: { id: true, nombre: true, orden: true },
      orderBy: [{ orden: 'asc' }, { nombre: 'asc' }]
    });
    res.json(profesionales);
  } catch (err) { next(err); }
});

// ── Admin: listar todas, con la info completa ──
router.get('/admin', authAdmin, async (req, res, next) => {
  try {
    const profesionales = await prisma.profesional.findMany({
      orderBy: [{ orden: 'asc' }, { nombre: 'asc' }]
    });
    res.json(profesionales);
  } catch (err) { next(err); }
});

// ── Admin: crear ───────────────────────────────
router.post('/', authAdmin, async (req, res, next) => {
  try {
    const { nombre, orden, telefono, comision_pct_default, activo } = req.body;

    if (!nombre || !String(nombre).trim()) {
      return res.status(400).json({ error: 'Falta el nombre' });
    }

    const profesional = await prisma.profesional.create({
      data: {
        nombre: String(nombre).trim(),
        orden: parseInt(orden) || 0,
        telefono: telefono ? String(telefono).trim() : null,
        // null = es la dueña del estudio, no se le liquida nada.
        comision_pct_default: validarPct(comision_pct_default),
        activo: activo === undefined ? true : !!activo
      }
    });
    res.status(201).json(profesional);
  } catch (err) { next(err); }
});

// ── Admin: actualizar ──────────────────────────
// Lista explícita de campos: no se pasa req.body a Prisma, para que el body no
// pueda escribir columnas que no corresponden.
router.patch('/:id', authAdmin, async (req, res, next) => {
  try {
    const { nombre, orden, telefono, comision_pct_default, activo } = req.body;
    const data = {};

    if (nombre !== undefined) data.nombre = String(nombre).trim();
    if (orden !== undefined) data.orden = parseInt(orden) || 0;
    if (telefono !== undefined) data.telefono = telefono ? String(telefono).trim() : null;
    if (comision_pct_default !== undefined) {
      data.comision_pct_default = validarPct(comision_pct_default);
    }
    if (activo !== undefined) data.activo = !!activo;

    const profesional = await prisma.profesional.update({
      where: { id: parseInt(req.params.id) },
      data
    });
    res.json(profesional);
  } catch (err) { next(err); }
});

// ── Admin: desactivar ──────────────────────────
// No se borra: sus turnos y su histórico de liquidaciones tienen que seguir
// existiendo. Desactivarla saca sus servicios de la web (ver routes/servicios).
router.delete('/:id', authAdmin, async (req, res, next) => {
  try {
    await prisma.profesional.update({
      where: { id: parseInt(req.params.id) },
      data: { activo: false }
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
