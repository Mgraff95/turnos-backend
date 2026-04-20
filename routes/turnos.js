const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const prisma = require('../lib/prisma');
const { obtenerHorariosDisponibles, calcularHoraFin, verificarYReservar } = require('../lib/availability');
const { enviarConfirmacion, enviarCancelacion, enviarModificacion, notificarTurnoTomadoWaitlist } = require('../services/whatsapp');
// ── Validar teléfono argentino (10 dígitos) ────
function validarTelefono(tel) {
  const limpio = tel.replace(/\D/g, '');
  return /^\d{10}$/.test(limpio) ? limpio : null;
}

// ── POST /api/turnos → Crear turno ─────────────
router.post('/', async (req, res, next) => {
  try {
    const { nombre, apellido, telefono, servicio_id, fecha, hora_inicio } = req.body;

    if (!nombre || !apellido || !telefono || !servicio_id || !fecha || !hora_inicio) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const telLimpio = validarTelefono(telefono);
    if (!telLimpio) {
      return res.status(400).json({ error: 'Teléfono inválido. Ingresá 10 dígitos (ej: 1123456789)' });
    }

    const servicio = await prisma.servicio.findUnique({
      where: { id: parseInt(servicio_id) }
    });
    if (!servicio || !servicio.activo) {
      return res.status(404).json({ error: 'Servicio no encontrado' });
    }

    const horaFin = calcularHoraFin(hora_inicio, servicio.duracion_minutos);

    const tokenExpires = new Date();
    tokenExpires.setDate(tokenExpires.getDate() + 30);

    const turno = await verificarYReservar({
      cliente_nombre: nombre.trim(),
      cliente_apellido: apellido.trim(),
      cliente_telefono: telLimpio,
      servicio_id: parseInt(servicio_id),
      fecha: new Date(fecha),
      hora_inicio,
      hora_fin: horaFin,
      estado: 'confirmado',
      token_acceso: uuidv4(),
      token_expires_at: tokenExpires
    });

    enviarConfirmacion(turno).catch(err =>
      console.error('Error enviando WA de confirmación:', err.message)
    );
// Verificar si este turno cubre un slot del waitlist → notificar a Daniela
    const franja = parseInt(turno.hora_inicio.split(':')[0]) < 14 ? 'manana' : 'tarde';
    const waitlistMatch = await prisma.waitlist.findFirst({
      where: {
        fecha: turno.fecha,
        franja,
        activo: true,
        notificado: true
      }
    });
    if (waitlistMatch) {
      notificarTurnoTomadoWaitlist(turno).catch(err =>
        console.error('Error notificando waitlist a Daniela:', err.message)
      );
      // Desactivar entradas de waitlist para esta fecha/franja
      prisma.waitlist.updateMany({
        where: { fecha: turno.fecha, franja, activo: true },
        data: { activo: false }
      }).catch(() => {});
    }

    res.status(201).json({
      id: turno.id,
      token: turno.token_acceso,
      turno,
      success: true
    });
  } catch (err) {
    if (err.message === 'HORARIO_NO_DISPONIBLE') {
      return res.status(409).json({ error: 'Ese horario ya no está disponible. Por favor elegí otro.' });
    }
    next(err);
  }
});

// ── GET /api/turnos/disponibilidad/:fecha/:servicio_id ─
router.get('/disponibilidad/:fecha/:servicio_id', async (req, res, next) => {
  try {
    const { fecha, servicio_id } = req.params;

    const servicio = await prisma.servicio.findUnique({
      where: { id: parseInt(servicio_id) }
    });
    if (!servicio) {
      return res.status(404).json({ error: 'Servicio no encontrado' });
    }

    const horarios = await obtenerHorariosDisponibles(
      new Date(fecha),
      servicio.duracion_minutos,
      parseInt(servicio_id)
    );

    res.json({ fecha, servicio: servicio.nombre, horarios });
  } catch (err) { next(err); }
});

// ── GET /api/turnos/mistura/:telefono/:apellido ─
router.get('/mistura/:telefono/:apellido', async (req, res, next) => {
  try {
    const { telefono, apellido } = req.params;
    const telLimpio = validarTelefono(telefono);

    if (!telLimpio) {
      return res.status(400).json({ error: 'Teléfono inválido' });
    }

    const turnos = await prisma.turno.findMany({
      where: {
        cliente_telefono: telLimpio,
        cliente_apellido: { equals: apellido.trim(), mode: 'insensitive' },
        estado: 'confirmado',
        fecha: { gte: new Date() }
      },
      include: { servicio: true },
      orderBy: [{ fecha: 'asc' }, { hora_inicio: 'asc' }]
    });

    res.json(turnos);
  } catch (err) { next(err); }
});

// ── PATCH /api/turnos/:id → Modificar turno ────
router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { token, nueva_fecha, nueva_hora_inicio, nuevo_servicio_id } = req.body;

    const turno = await prisma.turno.findUnique({
      where: { id: parseInt(id) },
      include: { servicio: true }
    });

    if (!turno || turno.token_acceso !== token) {
      return res.status(404).json({ error: 'Turno no encontrado' });
    }

    if (turno.estado !== 'confirmado') {
      return res.status(400).json({ error: 'Solo se pueden modificar turnos confirmados' });
    }

    // Verificar >= 48h antes
    const ahora = new Date();
    const fechaTurno = new Date(`${turno.fecha.toISOString().split('T')[0]}T${turno.hora_inicio}`);
    const horasRestantes = (fechaTurno - ahora) / (1000 * 60 * 60);

    if (horasRestantes < 48) {
      return res.status(400).json({ error: 'Solo podés modificar hasta 48h antes del turno' });
    }

    const servicioId = nuevo_servicio_id ? parseInt(nuevo_servicio_id) : turno.servicio_id;
    const servicio = await prisma.servicio.findUnique({ where: { id: servicioId } });
    const fecha = nueva_fecha || turno.fecha.toISOString().split('T')[0];
    const horaInicio = nueva_hora_inicio || turno.hora_inicio;
    const horaFin = calcularHoraFin(horaInicio, servicio.duracion_minutos);

    // Cancelar anterior + crear nuevo (atómico)
    const turnoActualizado = await prisma.$transaction(async (tx) => {
      await tx.turno.update({
        where: { id: parseInt(id) },
        data: { estado: 'cancelado' }
      });

      return tx.turno.create({
        data: {
          cliente_nombre: turno.cliente_nombre,
          cliente_apellido: turno.cliente_apellido,
          cliente_telefono: turno.cliente_telefono,
          servicio_id: servicioId,
          fecha: new Date(fecha),
          hora_inicio: horaInicio,
          hora_fin: horaFin,
          estado: 'confirmado',
          token_acceso: turno.token_acceso,
          token_expires_at: turno.token_expires_at
        },
        include: { servicio: true }
      });
    });

    enviarModificacion(turnoActualizado).catch(err =>
      console.error('Error enviando WA de modificación:', err.message)
    );

    res.json({ success: true, turno: turnoActualizado });
  } catch (err) { next(err); }
});

// ── DELETE /api/turnos/:id → Cancelar turno ────
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { token } = req.body;

    const turno = await prisma.turno.findUnique({
      where: { id: parseInt(id) },
      include: { servicio: true }
    });

    if (!turno || turno.token_acceso !== token) {
      return res.status(404).json({ error: 'Turno no encontrado' });
    }

    if (turno.estado !== 'confirmado') {
      return res.status(400).json({ error: 'Solo se pueden cancelar turnos confirmados' });
    }

    // Verificar >= 24h antes
    const ahora = new Date();
    const fechaTurno = new Date(`${turno.fecha.toISOString().split('T')[0]}T${turno.hora_inicio}`);
    const horasRestantes = (fechaTurno - ahora) / (1000 * 60 * 60);

    if (horasRestantes < 24) {
      return res.status(400).json({ error: 'Solo podés cancelar hasta 24h antes del turno' });
    }

    await prisma.turno.update({
      where: { id: parseInt(id) },
      data: { estado: 'cancelado' }
    });

    enviarCancelacion(turno).catch(err =>
      console.error('Error enviando WA de cancelación:', err.message)
    );

    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
