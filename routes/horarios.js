
const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { authAdmin } = require('../middleware/auth');

const soloProfesional = { select: { id: true, nombre: true } };

// ── Público: listar configuración de horarios ──
// Con ?profesional_id=N devuelve solo la agenda de esa profesional. Sin el
// parámetro devuelve todas con la profesional incluida, así el panel puede
// mostrar las dos agendas sin hacer dos pedidos.
router.get('/', async (req, res, next) => {
  try {
    const { profesional_id } = req.query;
    const where = {};
    if (profesional_id !== undefined) where.profesional_id = parseInt(profesional_id);

    const horarios = await prisma.horarioConfig.findMany({
      where,
      include: { profesional: soloProfesional },
      orderBy: [{ dia_semana: 'asc' }, { hora_inicio: 'asc' }]
    });
    res.json(horarios);
  } catch (err) { next(err); }
});

// ── Admin: agregar rango horario a un día ──────
router.post('/', authAdmin, async (req, res, next) => {
  try {
    const { dia_semana, hora_inicio, hora_fin, espacio_entre_turnos_min, profesional_id } = req.body;

    if (dia_semana === undefined || !hora_inicio || !hora_fin) {
      return res.status(400).json({ error: 'Faltan campos: dia_semana, hora_inicio, hora_fin' });
    }
    // Obligatorio: un rango sin profesional no se sabe de qué agenda es, y
    // dejarlo caer en una por defecto haría que una profesional ofrezca
    // horarios que no trabaja.
    if (profesional_id === undefined || profesional_id === null || profesional_id === '') {
      return res.status(400).json({ error: 'Hay que indicar de qué profesional es el horario' });
    }

    const horario = await prisma.horarioConfig.create({
      data: {
        dia_semana: parseInt(dia_semana),
        abierto: true,
        hora_inicio,
        hora_fin,
        espacio_entre_turnos_min: espacio_entre_turnos_min ?? 10,
        profesional_id: parseInt(profesional_id)
      },
      include: { profesional: soloProfesional }
    });
    res.status(201).json(horario);
  } catch (err) { next(err); }
});

// ── Admin: actualizar un rango específico ──────
// No se puede cambiar de profesional por acá: mover un rango de agenda es
// borrarlo y crearlo en la otra, no editarlo.
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
      include: { profesional: soloProfesional },
      orderBy: [{ fecha: 'asc' }, { hora_inicio: 'asc' }]
    });
    res.json(bloques);
  } catch (err) { next(err); }
});

// Alcance del bloqueo: sin profesional_id cierra el estudio para todas (un
// feriado, que es el comportamiento de siempre); con valor, cierra solo esa
// agenda y la otra sigue trabajando.
function alcanceDelBloqueo(profesional_id) {
  if (profesional_id === undefined || profesional_id === null || profesional_id === '') return null;
  return parseInt(profesional_id);
}

// ── Admin: crear bloque cerrado ────────────────
// Si se envían hora_inicio Y hora_fin, bloquea solo ese rango horario del día.
// Si se dejan vacíos, bloquea el día completo (comportamiento original).
router.post('/bloques-cerrados', authAdmin, async (req, res, next) => {
  try {
    const { fecha, motivo, hora_inicio, hora_fin, profesional_id } = req.body;
    if (!fecha) return res.status(400).json({ error: 'Falta campo: fecha' });

    // O se mandan las dos horas, o ninguna (día completo)
    const tieneInicio = !!hora_inicio;
    const tieneFin = !!hora_fin;
    if (tieneInicio !== tieneFin) {
      return res.status(400).json({ error: 'Para bloquear un rango horario específico, completá tanto la hora de inicio como la de fin' });
    }
    if (tieneInicio && tieneFin && hora_fin <= hora_inicio) {
      return res.status(400).json({ error: 'La hora de fin debe ser posterior a la hora de inicio' });
    }

    const bloque = await prisma.bloqueCerrado.create({
      data: {
        fecha: new Date(fecha),
        motivo,
        hora_inicio: tieneInicio ? hora_inicio : null,
        hora_fin: tieneFin ? hora_fin : null,
        profesional_id: alcanceDelBloqueo(profesional_id)
      },
      include: { profesional: soloProfesional }
    });
    res.status(201).json(bloque);
  } catch (err) { next(err); }
});

// ── Admin: actualizar bloque cerrado ───────────
// Misma validación que la creación: o se mandan las dos horas (bloquea ese rango),
// o ninguna (bloquea el día completo).
router.patch('/bloques-cerrados/:id', authAdmin, async (req, res, next) => {
  try {
    const { fecha, motivo, hora_inicio, hora_fin, profesional_id } = req.body;

    const tieneInicio = !!hora_inicio;
    const tieneFin = !!hora_fin;
    if (tieneInicio !== tieneFin) {
      return res.status(400).json({ error: 'Para bloquear un rango horario específico, completá tanto la hora de inicio como la de fin' });
    }
    if (tieneInicio && tieneFin && hora_fin <= hora_inicio) {
      return res.status(400).json({ error: 'La hora de fin debe ser posterior a la hora de inicio' });
    }

    const data = {
      motivo,
      hora_inicio: tieneInicio ? hora_inicio : null,
      hora_fin: tieneFin ? hora_fin : null
    };
    if (fecha) data.fecha = new Date(fecha);
    // Solo se toca el alcance si el body lo menciona: así un PATCH que edita el
    // motivo no convierte un bloqueo de una profesional en uno de todo el estudio.
    if (profesional_id !== undefined) {
      data.profesional_id = alcanceDelBloqueo(profesional_id);
    }

    const bloque = await prisma.bloqueCerrado.update({
      where: { id: parseInt(req.params.id) },
      data,
      include: { profesional: soloProfesional }
    });
    res.json(bloque);
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
