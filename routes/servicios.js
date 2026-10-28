const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { authAdmin } = require('../middleware/auth');
const { validarPct } = require('../lib/comisiones');

// Campos que el panel puede escribir en un servicio. Explícito a propósito:
// antes el POST descartaba en silencio todo lo que no estuviera en su lista
// (y así se perdían `intercalable` y compañía al crear), y el PATCH pasaba
// `req.body` entero a Prisma, con lo cual cualquier columna era escribible.
function datosDeServicio(body, { parcial } = {}) {
  const data = {};
  const puesto = (k) => body[k] !== undefined;

  if (puesto('nombre')) data.nombre = String(body.nombre).trim();
  if (puesto('duracion_minutos')) data.duracion_minutos = parseInt(body.duracion_minutos);
  if (puesto('precio_pesos')) data.precio_pesos = parseFloat(body.precio_pesos);
  if (puesto('activo')) data.activo = !!body.activo;

  if (puesto('profesional_id')) data.profesional_id = parseInt(body.profesional_id);
  if (puesto('comision_pct')) data.comision_pct = validarPct(body.comision_pct);

  if (puesto('incluye_nota')) data.incluye_nota = !!body.incluye_nota;
  if (puesto('nota')) data.nota = body.nota || null;

  // La camilla es un recurso del estudio, no de una profesional: hay una
  // sola. Tildarla acá es lo que hace que el servicio bloquee a los de
  // camilla de la otra agenda. Mientras esté en false no bloquea nada.
  if (puesto('usa_camilla')) data.usa_camilla = !!body.usa_camilla;

  // Intercalación: es para que una MISMA profesional se haga cargo de dos de
  // sus propios servicios a la vez. No tiene nada que ver con el paralelismo
  // entre profesionales, que lo resuelve profesional_id.
  if (puesto('intercalable')) data.intercalable = !!body.intercalable;
  if (puesto('intercalar_desde_min')) data.intercalar_desde_min = parseInt(body.intercalar_desde_min) || 0;
  if (puesto('max_simultaneos')) data.max_simultaneos = parseInt(body.max_simultaneos) || 2;
  if (puesto('servicios_compatibles')) {
    data.servicios_compatibles = Array.isArray(body.servicios_compatibles)
      ? body.servicios_compatibles.map(n => parseInt(n)).filter(n => !isNaN(n))
      : [];
  }

  if (!parcial) {
    if (!data.nombre || !data.duracion_minutos || isNaN(data.precio_pesos)) {
      throw Object.assign(new Error('FALTAN_CAMPOS'), {
        status: 400,
        publico: 'Faltan campos: nombre, duracion_minutos, precio_pesos'
      });
    }
    if (!data.profesional_id) {
      throw Object.assign(new Error('FALTA_PROFESIONAL'), {
        status: 400,
        publico: 'Hay que indicar de qué profesional es el servicio'
      });
    }
  }

  return data;
}

// ── Público: listar servicios activos ──────────
// Filtra también por profesional activa: si se desactiva a una profesional,
// sus servicios dejan de tomar turnos sin tener que desactivarlos uno por uno.
router.get('/', async (req, res, next) => {
  try {
    // select explicito y no include: con include, Prisma devuelve TODOS los
    // escalares de Servicio, incluido comision_pct. Ese porcentaje es el reparto
    // de plata entre el estudio y la profesional, y este endpoint es publico.
    const servicios = await prisma.servicio.findMany({
      where: { activo: true, profesional: { activo: true } },
      select: {
        id: true, nombre: true, duracion_minutos: true, precio_pesos: true, activo: true,
        intercalable: true, intercalar_desde_min: true, servicios_compatibles: true,
        max_simultaneos: true, incluye_nota: true, nota: true, profesional_id: true,
        profesional: { select: { id: true, nombre: true, orden: true } }
      },
      orderBy: [{ profesional: { orden: 'asc' } }, { nombre: 'asc' }]
    });
    res.json(servicios);
  } catch (err) { next(err); }
});

// ── Admin: listar todos, incluidos los inactivos ──
router.get('/admin', authAdmin, async (req, res, next) => {
  try {
    const servicios = await prisma.servicio.findMany({
      include: { profesional: { select: { id: true, nombre: true, orden: true, comision_pct_default: true } } },
      orderBy: [{ profesional: { orden: 'asc' } }, { nombre: 'asc' }]
    });
    res.json(servicios);
  } catch (err) { next(err); }
});

// ── Admin: crear servicio ──────────────────────
router.post('/', authAdmin, async (req, res, next) => {
  try {
    const servicio = await prisma.servicio.create({
      data: datosDeServicio(req.body),
      include: { profesional: { select: { id: true, nombre: true } } }
    });
    res.status(201).json(servicio);
  } catch (err) { next(err); }
});

// ── Admin: actualizar servicio ─────────────────
router.patch('/:id', authAdmin, async (req, res, next) => {
  try {
    const servicio = await prisma.servicio.update({
      where: { id: parseInt(req.params.id) },
      data: datosDeServicio(req.body, { parcial: true }),
      include: { profesional: { select: { id: true, nombre: true } } }
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
