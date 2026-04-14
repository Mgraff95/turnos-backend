const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { authAdmin } = require('../middleware/auth');

// ── Público: listar configuración de horarios ──
router.get('/', async (req, res, next) => {
  try {
    const horarios = await prisma.horarioConfig.findMany({
      orderBy: { dia_semana: 'asc' }
    });
    res.json(horarios);
  } catch (err) { next(err); }
});

// ── Admin: actualizar horario de un día ────────
router.patch('/:dia_semana', authAdmin, async (req, res, next) => {
  try {
    const dia = parseInt(req.params.dia_semana);
    const { abierto, hora_inicio, hora_fin, espacio_entre_turnos_min } = req.body;

    const horario = await prisma.horarioConfig.upsert({
      where: { dia_semana: dia },
      create: {
        dia_semana: dia,
        abierto: abierto ?? true,
        hora_inicio: hora_inicio || '09:00',
        hora_fin: hora_fin || '18:00',
        espacio_entre_turnos_min: espacio_entre_turnos_min ?? 10
      },
      update: { abierto, hora_inicio, hora_fin, espacio_entre_turnos_min }
    });
    res.json(horario);
  } catch (err) { next(err); }
});

// ── Admin: listar bloques cerrados ─────────────
router.get('/bloques-cerrados', async (req, res, next) => {
  try {
    const bloques = await prisma.bloqueCerrado.findMany({
      orderBy: { fecha: 'asc' }
    });
    res.json(bloques);
  } catch (err) { next(err); }
});

// ── Admin: crear bloque cerrado ────────────────
router.post('/bloques-cerrados', authAdmin, async (req, res, next) => {
  try {
    const { fecha, motivo } = req.body;
    if (!fecha) {
      return res.status(400).json({ error: 'Falta campo: fecha' });
    }

    const bloque = await prisma.bloqueCerrado.create({
      data: { fecha: new Date(fecha), motivo }
    });
    res.status(201).json(bloque);
  } catch (err) { next(err); }
});

// ── Admin: eliminar bloque cerrado ─────────────
router.delete('/bloques-cerrados/:id', authAdmin, async (req, res, next) => {
  try {
    await prisma.bloqueCerrado.delete({
      where: { id: parseInt(req.params.id) }
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
