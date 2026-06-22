const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const prisma = require('../lib/prisma');
const {
  obtenerHorariosDisponibles,
  obtenerHorariosDisponiblesBloque,
  calcularHoraFin,
  verificarYReservar,
  verificarYReservarBloque
} = require('../lib/availability');
const {
  enviarConfirmacion,
  enviarConfirmacionGrupo,
  enviarCancelacion,
  enviarCancelacionGrupo,
  enviarModificacion,
  enviarAsistenciaConfirmada,
  notificarCancelacionADaniela,
  notificarCancelacionGrupoADaniela,
  notificarWaitlist,
  notificarTurnoTomadoWaitlist
} = require('../services/whatsapp');

// ── Validar teléfono argentino (10 dígitos) ────
function validarTelefono(tel) {
  const limpio = tel.replace(/\D/g, '');
  return /^\d{10}$/.test(limpio) ? limpio : null;
}

// ── Determinar franja horaria ──────────────────
function determinarFranja(horaInicio) {
  const hora = parseInt(horaInicio.split(':')[0]);
  return hora < 14 ? 'manana' : 'tarde';
}

// ── Resolver extras válidos para un servicio ───
// Devuelve solo los extras activos que efectivamente se ofrecen para ese servicio.
async function resolverExtras(extrasInput, servicioId) {
  if (!extrasInput) return [];
  const arr = Array.isArray(extrasInput)
    ? extrasInput
    : String(extrasInput).split(',');
  const ids = arr.map(n => parseInt(n)).filter(n => !isNaN(n));
  if (ids.length === 0) return [];
  return prisma.extra.findMany({
    where: {
      id: { in: ids },
      activo: true,
      servicios_ids: { has: servicioId }
    }
  });
}

// ── Notificar/desactivar waitlist para las franjas de un turno tomado ──
async function procesarWaitlistTomado(fecha, franja, turnoParaNotificar) {
  const waitlistMatch = await prisma.waitlist.findFirst({
    where: { fecha, franja, activo: true, notificado: true }
  });
  if (waitlistMatch) {
    notificarTurnoTomadoWaitlist(turnoParaNotificar).catch(err =>
      console.error('Error notificando waitlist a Daniela:', err.message)
    );
    await prisma.waitlist.updateMany({
      where: { fecha, franja, activo: true },
      data: { activo: false }
    }).catch(() => {});
  }
}

// ── POST /api/turnos → Crear turno (1 servicio) ─────────────
router.post('/', async (req, res, next) => {
  try {
    const { nombre, apellido, telefono, servicio_id, fecha, hora_inicio, extras } = req.body;

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

    // Resolver extras elegidos (suman tiempo y precio)
    const extrasValidos = await resolverExtras(extras, parseInt(servicio_id));
    const minutosExtra = extrasValidos.reduce((s, e) => s + (e.minutos_adicionales || 0), 0);
    const duracionTotal = servicio.duracion_minutos + minutosExtra;

    const horaFin = calcularHoraFin(hora_inicio, duracionTotal);

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
      extras_ids: extrasValidos.map(e => e.id),
      estado: 'confirmado',
      token_acceso: uuidv4(),
      token_expires_at: tokenExpires
    });

    // Adjuntar los extras al objeto para el mensaje de WhatsApp
    turno.extras = extrasValidos;

    enviarConfirmacion(turno).catch(err =>
      console.error('Error enviando WA de confirmación:', err.message)
    );

    // Verificar si este turno cubre un slot del waitlist → notificar a Daniela
    const franja = determinarFranja(turno.hora_inicio);
    await procesarWaitlistTomado(turno.fecha, franja, turno);

    res.status(201).json({ id: turno.id, token: turno.token_acceso, turno, success: true });
  } catch (err) {
    if (err.message === 'HORARIO_NO_DISPONIBLE') {
      return res.status(409).json({ error: 'Ese horario ya no está disponible. Por favor elegí otro.' });
    }
    next(err);
  }
});

// ── POST /api/turnos/multi → Crear reserva múltiple (bloque continuo) ──
// body: { nombre, apellido, telefono, fecha, hora_inicio,
//         servicios: [ { servicio_id, extras: [ids] }, ... ] }
router.post('/multi', async (req, res, next) => {
  try {
    const { nombre, apellido, telefono, fecha, hora_inicio, servicios } = req.body;

    if (!nombre || !apellido || !telefono || !fecha || !hora_inicio) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }
    if (!Array.isArray(servicios) || servicios.length < 2) {
      return res.status(400).json({ error: 'Una reserva múltiple necesita al menos 2 servicios' });
    }

    const telLimpio = validarTelefono(telefono);
    if (!telLimpio) {
      return res.status(400).json({ error: 'Teléfono inválido. Ingresá 10 dígitos (ej: 1123456789)' });
    }

    // Resolver cada servicio + sus extras, en el orden enviado
    const items = [];
    for (const item of servicios) {
      const sid = parseInt(item.servicio_id);
      const servicio = await prisma.servicio.findUnique({ where: { id: sid } });
      if (!servicio || !servicio.activo) {
        return res.status(404).json({ error: `Servicio ${item.servicio_id} no encontrado` });
      }
      const extrasValidos = await resolverExtras(item.extras, sid);
      const minutosExtra = extrasValidos.reduce((s, e) => s + (e.minutos_adicionales || 0), 0);
      items.push({
        servicio,
        extras: extrasValidos,
        duracion: servicio.duracion_minutos + minutosExtra
      });
    }

    // Encadenar los sub-turnos uno detrás del otro (pegados, sin espacio interno)
    const grupoReserva = uuidv4();
    const tokenExpires = new Date();
    tokenExpires.setDate(tokenExpires.getDate() + 30);

    let cursor = hora_inicio;
    const turnosData = [];
    items.forEach((item, idx) => {
      const inicio = cursor;
      const fin = calcularHoraFin(inicio, item.duracion);
      turnosData.push({
        cliente_nombre: nombre.trim(),
        cliente_apellido: apellido.trim(),
        cliente_telefono: telLimpio,
        servicio_id: item.servicio.id,
        fecha: new Date(fecha),
        hora_inicio: inicio,
        hora_fin: fin,
        extras_ids: item.extras.map(e => e.id),
        grupo_reserva: grupoReserva,
        orden_en_grupo: idx + 1,
        estado: 'confirmado',
        token_acceso: uuidv4(),
        token_expires_at: tokenExpires
      });
      cursor = fin;
    });

    const rangoInicio = hora_inicio;
    const rangoFin = cursor;

    const turnosCreados = await verificarYReservarBloque(turnosData, rangoInicio, rangoFin);

    // Adjuntar extras a cada turno creado (mismo orden) para el mensaje
    turnosCreados.forEach((t, idx) => { t.extras = items[idx].extras; });

    enviarConfirmacionGrupo(turnosCreados).catch(err =>
      console.error('Error enviando WA de confirmación de grupo:', err.message)
    );

    // Waitlist: notificar por cada franja única cubierta por el bloque
    const franjasCubiertas = [...new Set(turnosCreados.map(t => determinarFranja(t.hora_inicio)))];
    for (const franja of franjasCubiertas) {
      await procesarWaitlistTomado(new Date(fecha), franja, turnosCreados[0]);
    }

    res.status(201).json({
      success: true,
      grupo_reserva: grupoReserva,
      hora_inicio: rangoInicio,
      hora_fin: rangoFin,
      turnos: turnosCreados
    });
  } catch (err) {
    if (err.message === 'HORARIO_NO_DISPONIBLE') {
      return res.status(409).json({ error: 'Ese horario ya no está disponible para todos los servicios. Por favor elegí otro.' });
    }
    next(err);
  }
});

// ── GET /api/turnos/confirmar?token=XXX → Confirmar asistencia por link ──
router.get('/confirmar', async (req, res, next) => {
  try {
    const { token } = req.query;
    const frontendUrl = process.env.FRONTEND_URL;

    if (!token) {
      return res.redirect(`${frontendUrl}/respuesta?estado=error&msg=Token+inválido`);
    }

    const turno = await prisma.turno.findFirst({
      where: { token_acceso: token },
      include: { servicio: true }
    });

    if (!turno) {
      return res.redirect(`${frontendUrl}/respuesta?estado=error&msg=Turno+no+encontrado`);
    }

    if (turno.estado !== 'confirmado') {
      return res.redirect(`${frontendUrl}/respuesta?estado=error&msg=El+turno+ya+no+está+activo`);
    }

    // Verificar que el recordatorio fue enviado (solo confirmar si recibió el recordatorio)
    if (!turno.recordatorio_enviado) {
      return res.redirect(`${frontendUrl}/respuesta?estado=error&msg=No+hay+recordatorio+pendiente`);
    }

    console.log(`✅ ${turno.cliente_nombre} confirmó asistencia por link (turno #${turno.id})`);

    // Enviar mensaje de confirmación
    enviarAsistenciaConfirmada(turno).catch(err =>
      console.error('Error enviando WA asistencia confirmada:', err.message)
    );

    return res.redirect(`${frontendUrl}/respuesta?estado=confirmado`);
  } catch (err) { next(err); }
});

// ── GET /api/turnos/cancelar?token=XXX → Cancelar por link ──
router.get('/cancelar', async (req, res, next) => {
  try {
    const { token } = req.query;
    const frontendUrl = process.env.FRONTEND_URL;

    if (!token) {
      return res.redirect(`${frontendUrl}/respuesta?estado=error&msg=Token+inválido`);
    }

    const turno = await prisma.turno.findFirst({
      where: { token_acceso: token },
      include: { servicio: true }
    });

    if (!turno) {
      return res.redirect(`${frontendUrl}/respuesta?estado=error&msg=Turno+no+encontrado`);
    }

    if (turno.estado !== 'confirmado') {
      return res.redirect(`${frontendUrl}/respuesta?estado=error&msg=El+turno+ya+no+está+activo`);
    }

    // ── Reserva múltiple: cancelar TODO el bloque ──
    if (turno.grupo_reserva) {
      const grupo = await prisma.turno.findMany({
        where: { grupo_reserva: turno.grupo_reserva, estado: 'confirmado' },
        include: { servicio: true },
        orderBy: { orden_en_grupo: 'asc' }
      });

      // El control de 24h se hace contra el primer turno del bloque
      const primero = grupo[0] || turno;
      const ahora = new Date();
      const fechaTurno = new Date(`${primero.fecha.toISOString().split('T')[0]}T${primero.hora_inicio}`);
      const horasRestantes = (fechaTurno - ahora) / (1000 * 60 * 60);
      if (horasRestantes < 24) {
        return res.redirect(`${frontendUrl}/respuesta?estado=error&msg=Solo+podés+cancelar+hasta+24hs+antes`);
      }

      await prisma.turno.updateMany({
        where: { grupo_reserva: turno.grupo_reserva, estado: 'confirmado' },
        data: { estado: 'cancelado' }
      });

      console.log(`❌ ${primero.cliente_nombre} canceló su reserva múltiple (grupo ${turno.grupo_reserva})`);

      enviarCancelacionGrupo(grupo).catch(err =>
        console.error('Error enviando WA cancelación de grupo:', err.message)
      );
      notificarCancelacionGrupoADaniela(grupo).catch(err =>
        console.error('Error notificando cancelación de grupo a Daniela:', err.message)
      );

      // Notificar waitlist por cada franja liberada
      const franjas = [...new Set(grupo.map(t => determinarFranja(t.hora_inicio)))];
      for (const franja of franjas) {
        const esperando = await prisma.waitlist.findMany({
          where: { fecha: primero.fecha, franja, activo: true, notificado: false },
          include: { servicio: true }
        });
        for (const entrada of esperando) {
          const enviado = await notificarWaitlist(entrada, primero.hora_inicio);
          if (enviado) {
            await prisma.waitlist.update({ where: { id: entrada.id }, data: { notificado: true } });
          }
        }
      }

      return res.redirect(`${frontendUrl}/respuesta?estado=cancelado`);
    }

    // ── Turno simple ──
    const ahora = new Date();
    const fechaTurno = new Date(`${turno.fecha.toISOString().split('T')[0]}T${turno.hora_inicio}`);
    const horasRestantes = (fechaTurno - ahora) / (1000 * 60 * 60);

    if (horasRestantes < 24) {
      return res.redirect(`${frontendUrl}/respuesta?estado=error&msg=Solo+podés+cancelar+hasta+24hs+antes`);
    }

    await prisma.turno.update({
      where: { id: turno.id },
      data: { estado: 'cancelado' }
    });

    console.log(`❌ ${turno.cliente_nombre} canceló por link (turno #${turno.id})`);

    enviarCancelacion(turno).catch(err =>
      console.error('Error enviando WA cancelación:', err.message)
    );
    notificarCancelacionADaniela(turno).catch(err =>
      console.error('Error notificando cancelación a Daniela:', err.message)
    );

    // Notificar waitlist
    const franja = determinarFranja(turno.hora_inicio);
    const esperando = await prisma.waitlist.findMany({
      where: { fecha: turno.fecha, franja, activo: true, notificado: false },
      include: { servicio: true }
    });
    for (const entrada of esperando) {
      const enviado = await notificarWaitlist(entrada, turno.hora_inicio);
      if (enviado) {
        await prisma.waitlist.update({
          where: { id: entrada.id },
          data: { notificado: true }
        });
      }
    }

    return res.redirect(`${frontendUrl}/respuesta?estado=cancelado`);
  } catch (err) { next(err); }
});

// ── GET /api/turnos/disponibilidad/:fecha/:servicio_id ─
// Acepta ?extras=1,2,3 para sumar el tiempo de los extras a la duración.
router.get('/disponibilidad/:fecha/:servicio_id', async (req, res, next) => {
  try {
    const { fecha, servicio_id } = req.params;
    const { extras } = req.query;

    const servicio = await prisma.servicio.findUnique({
      where: { id: parseInt(servicio_id) }
    });
    if (!servicio) {
      return res.status(404).json({ error: 'Servicio no encontrado' });
    }

    const extrasValidos = await resolverExtras(extras, parseInt(servicio_id));
    const minutosExtra = extrasValidos.reduce((s, e) => s + (e.minutos_adicionales || 0), 0);

    const horarios = await obtenerHorariosDisponibles(
      new Date(fecha),
      servicio.duracion_minutos + minutosExtra,
      parseInt(servicio_id)
    );

    res.json({ fecha, servicio: servicio.nombre, horarios });
  } catch (err) { next(err); }
});

// ── POST /api/turnos/disponibilidad-multi → disponibilidad de un bloque ──
// body: { fecha, servicios: [ { servicio_id, extras: [ids] }, ... ] }
router.post('/disponibilidad-multi', async (req, res, next) => {
  try {
    const { fecha, servicios } = req.body;
    if (!fecha || !Array.isArray(servicios) || servicios.length === 0) {
      return res.status(400).json({ error: 'Faltan datos (fecha y servicios)' });
    }

    // Sumar la duración de todos los servicios + sus extras válidos
    let duracionTotal = 0;
    for (const item of servicios) {
      const sid = parseInt(item.servicio_id);
      const servicio = await prisma.servicio.findUnique({ where: { id: sid } });
      if (!servicio) {
        return res.status(404).json({ error: `Servicio ${item.servicio_id} no encontrado` });
      }
      const extrasValidos = await resolverExtras(item.extras, sid);
      const minutosExtra = extrasValidos.reduce((s, e) => s + (e.minutos_adicionales || 0), 0);
      duracionTotal += servicio.duracion_minutos + minutosExtra;
    }

    const horarios = await obtenerHorariosDisponiblesBloque(new Date(fecha), duracionTotal);
    res.json({ fecha, duracion_total: duracionTotal, horarios });
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

    // Por ahora, los turnos que forman parte de una reserva múltiple no se editan
    // individualmente (mover uno desencadena el resto). Se cancela y se reserva de nuevo.
    if (turno.grupo_reserva) {
      return res.status(400).json({ error: 'Este turno es parte de una reserva múltiple. Para cambiarlo, cancelalo y reservá de nuevo.' });
    }

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

    // ── Reserva múltiple: cancelar TODO el bloque ──
    if (turno.grupo_reserva) {
      const grupo = await prisma.turno.findMany({
        where: { grupo_reserva: turno.grupo_reserva, estado: 'confirmado' },
        include: { servicio: true },
        orderBy: { orden_en_grupo: 'asc' }
      });
      const primero = grupo[0] || turno;

      const ahora = new Date();
      const fechaTurno = new Date(`${primero.fecha.toISOString().split('T')[0]}T${primero.hora_inicio}`);
      const horasRestantes = (fechaTurno - ahora) / (1000 * 60 * 60);
      if (horasRestantes < 24) {
        return res.status(400).json({ error: 'Solo podés cancelar hasta 24h antes del turno' });
      }

      await prisma.turno.updateMany({
        where: { grupo_reserva: turno.grupo_reserva, estado: 'confirmado' },
        data: { estado: 'cancelado' }
      });

      enviarCancelacionGrupo(grupo).catch(err =>
        console.error('Error enviando WA de cancelación de grupo:', err.message)
      );

      return res.json({ success: true });
    }

    // ── Turno simple ──
    const ahora = new Date();
    const fechaTurno = new Date(`${turno.fecha.toISOString().split('T')[0]}T${turno.hora_inicio}`);
    const horasRestantes = (fechaTurno - ahora) / (1000 * 60 * 60);

    if (horasRestantes < 24) {
      return res.status(400).json({ error: 'Solo podés cancelar hasta 24h antes del turno' });
    }

    await prisma.turno.update({
      where: { id: turno.id },
      data: { estado: 'cancelado' }
    });

    enviarCancelacion(turno).catch(err =>
      console.error('Error enviando WA de cancelación:', err.message)
    );

    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
