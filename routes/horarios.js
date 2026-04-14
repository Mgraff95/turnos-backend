const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { authAdmin } = require('../middleware/auth');

// ── Público: listar configuración de horarios ──
router.get('/', async (req, res, next) => {
  try {
    const horarios = await prisma.horarioConfig.findMany({
      orderBy: [{ dia_semana: 'asc' }, { hora_inicio: 'asc' }]
    });
    res.json(horarios);
  } catch (err) { next(err); }
});

// ── Admin: agregar rango horario a un día ──────
router.post('/', authAdmin, async (req, res, next) => {
  try {
    const { dia_semana, hora_inicio, hora_fin, espacio_entre_turnos_min } = req.body;

    if (dia_semana === undefined || !hora_inicio || !hora_fin) {
      return res.status(400).json({ error: 'Faltan campos: dia_semana, hora_inicio, hora_fin' });
    }

    const horario = await prisma.horarioConfig.create({
      data: {
        dia_semana: parseInt(dia_semana),
        abierto: true,
        hora_inicio,
        hora_fin,
        espacio_entre_turnos_min: espacio_entre_turnos_min ?? 10
      }
    });
    res.status(201).json(horario);
  } catch (err) { next(err); }
});

// ── Admin: actualizar un rango específico ──────
router.patch('/:id', authAdmin, async (req, res, next) => {
  try {
    const { abierto, hora_inicio, hora_fin, espacio_entre_turnos_min } = req.body;
    const horario = await prisma.horarioConfig.update({
      where: { id: parseInt(req.params.id) },
      data: { abierto, hora_inicio, hora_fin, espacio_entre_turnos_min }
    });
    res.json(horario);
  } catch (err) { next(err); }
});

// ── Admin: eliminar un rango horario ───────────
router.delete('/:id', authAdmin, async (req, res, next) => {
  try {
    await prisma.horarioConfig.delete({
      where: { id: parseInt(req.params.id) }
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Público: listar bloques cerrados ───────────
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
    if (!fecha) return res.status(400).json({ error: 'Falta campo: fecha' });

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
