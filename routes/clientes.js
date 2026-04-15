const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { authAdmin } = require('../middleware/auth');

// ── GET /api/admin/clientes → Lista de clientes ──
router.get('/', authAdmin, async (req, res, next) => {
  try {
    const turnos = await prisma.turno.findMany({
      include: { servicio: true },
      orderBy: [{ fecha: 'desc' }, { hora_inicio: 'desc' }]
    });

    // Agrupar por teléfono
    const clienteMap = {};
    turnos.forEach(t => {
      const key = t.cliente_telefono;
      if (!clienteMap[key]) {
        clienteMap[key] = {
          telefono: key,
          nombre: t.cliente_nombre,
          apellido: t.cliente_apellido,
          turnos: [],
          totalConfirmados: 0,
          totalCancelados: 0,
          servicios: {},
          gastoTotal: 0,
          primeraVisita: t.fecha,
          ultimaVisita: t.fecha
        };
      }
      const c = clienteMap[key];
      c.turnos.push(t);

      if (t.estado === 'confirmado') {
        c.totalConfirmados++;
        c.gastoTotal += t.servicio ? parseFloat(t.servicio.precio_pesos) : 0;
        const sNombre = t.servicio?.nombre || 'Otro';
        c.servicios[sNombre] = (c.servicios[sNombre] || 0) + 1;
      } else if (t.estado === 'cancelado') {
        c.totalCancelados++;
      }

      if (new Date(t.fecha) < new Date(c.primeraVisita)) c.primeraVisita = t.fecha;
      if (new Date(t.fecha) > new Date(c.ultimaVisita)) c.ultimaVisita = t.fecha;
    });

    const clientes = Object.values(clienteMap).map(c => ({
      ...c,
      totalTurnos: c.totalConfirmados + c.totalCancelados,
      tasaCancelacion: c.totalConfirmados + c.totalCancelados > 0
        ? ((c.totalCancelados / (c.totalConfirmados + c.totalCancelados)) * 100).toFixed(1)
        : 0,
      servicioFavorito: Object.entries(c.servicios).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A',
      turnos: undefined // No enviar todos los turnos en la lista
    }));

    clientes.sort((a, b) => b.totalConfirmados - a.totalConfirmados);
    res.json(clientes);
  } catch (err) { next(err); }
});

// ── GET /api/admin/clientes/:telefono → Ficha completa ──
router.get('/:telefono', authAdmin, async (req, res, next) => {
  try {
    const { telefono } = req.params;

    const turnos = await prisma.turno.findMany({
      where: { cliente_telefono: telefono },
      include: { servicio: true },
      orderBy: [{ fecha: 'desc' }, { hora_inicio: 'desc' }]
    });

    if (turnos.length === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    const notas = await prisma.notaCliente.findMany({
      where: { cliente_telefono: telefono },
      orderBy: { created_at: 'desc' }
    });

    res.json({ turnos, notas });
  } catch (err) { next(err); }
});

// ── POST /api/admin/clientes/:telefono/notas → Agregar nota ──
router.post('/:telefono/notas', authAdmin, async (req, res, next) => {
  try {
    const { telefono } = req.params;
    const { texto } = req.body;

    if (!texto || !texto.trim()) {
      return res.status(400).json({ error: 'La nota no puede estar vacía' });
    }

    const nota = await prisma.notaCliente.create({
      data: {
        cliente_telefono: telefono,
        texto: texto.trim()
      }
    });

    res.status(201).json(nota);
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/clientes/:telefono/notas/:id → Eliminar nota ──
router.delete('/:telefono/notas/:id', authAdmin, async (req, res, next) => {
  try {
    await prisma.notaCliente.delete({
      where: { id: parseInt(req.params.id) }
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;