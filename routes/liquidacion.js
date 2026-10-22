const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { authAdmin } = require('../middleware/auth');
const { redondear } = require('../lib/redondeo');

// Reporte de liquidación de una profesional en un período.
//
// Lee SIEMPRE los campos congelados del turno (precio_base, comision_pct,
// comision_monto), nunca el precio actual del servicio. Es la razón de ser de
// esas columnas: si Daniela sube un precio en noviembre, la liquidación de
// octubre que ya le compartió a Elsa tiene que seguir diciendo lo mismo.

function fechaValida(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return isNaN(d.getTime()) ? null : d;
}

// ── GET /api/admin/liquidacion?profesional_id=&desde=&hasta= ──
router.get('/', authAdmin, async (req, res, next) => {
  try {
    const { profesional_id, desde, hasta } = req.query;

    // Los tres parámetros son obligatorios. Sin esto, un pedido sin `hasta`
    // devolvería el histórico completo y se le cobraría a la profesional todo
    // de una vez.
    if (!profesional_id || !desde || !hasta) {
      return res.status(400).json({ error: 'Faltan parámetros: profesional_id, desde, hasta' });
    }

    const desdeDate = fechaValida(desde);
    const hastaDate = fechaValida(hasta);
    if (!desdeDate || !hastaDate) {
      return res.status(400).json({ error: 'Las fechas tienen que venir como YYYY-MM-DD' });
    }
    if (desdeDate > hastaDate) {
      return res.status(400).json({ error: 'El rango de fechas está invertido' });
    }

    const idProf = parseInt(profesional_id);
    if (isNaN(idProf)) {
      return res.status(400).json({ error: 'profesional_id inválido' });
    }

    const profesional = await prisma.profesional.findUnique({
      where: { id: idProf },
      select: { id: true, nombre: true, telefono: true, comision_pct_default: true }
    });
    if (!profesional) {
      return res.status(404).json({ error: 'Profesional no encontrada' });
    }
    // Una profesional sin comisión es la dueña del estudio: su plata ya es del
    // estudio y no hay nada que liquidar.
    if (profesional.comision_pct_default === null) {
      return res.status(400).json({ error: 'Esa profesional no tiene comisión configurada' });
    }

    const turnos = await prisma.turno.findMany({
      where: {
        profesional_id: profesional.id,
        estado: 'confirmado',
        // La clienta que no vino no se liquida: el turno sigue confirmado para
        // todo lo demás, pero no se le cobra comisión por un servicio que no hizo.
        liquidable: true,
        fecha: { gte: desdeDate, lte: hastaDate }
      },
      include: { servicio: { select: { nombre: true } } },
      orderBy: [{ fecha: 'asc' }, { hora_inicio: 'asc' }]
    });

    const detalle = turnos.map(t => ({
      id: t.id,
      fecha: t.fecha,
      hora_inicio: t.hora_inicio,
      cliente_nombre: t.cliente_nombre,
      cliente_apellido: t.cliente_apellido,
      servicio_nombre: t.servicio.nombre,
      precio_base: t.precio_base === null ? null : Number(t.precio_base),
      comision_pct: t.comision_pct === null ? null : Number(t.comision_pct),
      comision_monto: t.comision_monto === null ? null : Number(t.comision_monto)
    }));

    const facturado = redondear(detalle.reduce((s, t) => s + (t.precio_base || 0), 0));
    const comision = redondear(detalle.reduce((s, t) => s + (t.comision_monto || 0), 0));

    // Turnos sin la foto de la plata: los que existían antes de la migración, o
    // los que entraron por un camino que no pasó por el helper de comisión. Se
    // informan para que Daniela sepa que el total no los cuenta.
    const sinDatos = detalle.filter(t => t.comision_monto === null).length;

    res.json({
      profesional: {
        id: profesional.id,
        nombre: profesional.nombre,
        telefono: profesional.telefono,
        comision_pct_default: Number(profesional.comision_pct_default)
      },
      desde,
      hasta,
      turnos: detalle,
      totales: {
        facturado,
        comision,
        cantidad_turnos: detalle.length,
        turnos_sin_comision_registrada: sinDatos
      }
    });
  } catch (err) { next(err); }
});

module.exports = router;
