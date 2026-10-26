
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const prisma = require('../lib/prisma');
const { validarTelefono, resolverExtras, resolverProfesionalYPlata } = require('../lib/reservas');
const { demasiadoCerca, errorAntelacion } = require('../lib/fechas');
const {
  obtenerHorariosDisponibles,
  obtenerHorariosDisponiblesBloque,
  resolverBloqueConIntercalados,
  calcularHoraFin,
  verificarYReservar,
  verificarYReservarBloque,
  horaAMinutos,
  minutosAHora
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
  notificarNuevoTurnoADaniela,
  notificarNuevoTurnoGrupoADaniela,
  notificarModificacionADaniela,
  notificarWaitlist,
  notificarTurnoTomadoWaitlist
} = require('../services/whatsapp');
 
// ── Determinar franja horaria ──────────────────
function determinarFranja(horaInicio) {
  const hora = parseInt(horaInicio.split(':')[0]);
  return hora < 14 ? 'manana' : 'tarde';
}
 
// ── Notificar/desactivar waitlist para las franjas de un turno tomado ──
async function procesarWaitlistTomado(fecha, franja, turnoParaNotificar) {
  // Acotado a la agenda de la profesional del turno que se tomo. Sin el filtro,
  // llenar un hueco de una profesional daba de baja (activo: false) las
  // entradas de quien esperaba a OTRA, en silencio y para siempre, aunque esa
  // otra agenda siguiera con lugar.
  const deEstaProfesional = { servicio: { profesional_id: turnoParaNotificar.profesional_id } };

  const waitlistMatch = await prisma.waitlist.findFirst({
    where: { fecha, franja, activo: true, notificado: true, ...deEstaProfesional }
  });
  if (waitlistMatch) {
    notificarTurnoTomadoWaitlist(turnoParaNotificar).catch(err =>
      console.error('Error notificando waitlist a Daniela:', err.message)
    );
    await prisma.waitlist.updateMany({
      where: { fecha, franja, activo: true, ...deEstaProfesional },
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

    // Antelacion minima. Solo en la web: las rutas del panel van con authAdmin
    // y no pasan por aca, asi que Daniela puede cargar un turno para hoy.
    if (demasiadoCerca(fecha, hora_inicio)) {
      return res.status(400).json({ error: errorAntelacion().publico });
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
 
    // Profesional del turno y plata congelada (precio y comisión al momento de
    // reservar). Sale del helper compartido para que los cinco lugares que
    // crean turnos resuelvan la plata del mismo modo.
    const { profesionalId, plataPorServicioId } = await resolverProfesionalYPlata([
      { servicio, extras: extrasValidos }
    ]);

    const turno = await verificarYReservar({
      cliente_nombre: nombre.trim(),
      cliente_apellido: apellido.trim(),
      cliente_telefono: telLimpio,
      servicio_id: parseInt(servicio_id),
      profesional_id: profesionalId,
      ...plataPorServicioId[servicio.id],
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
    notificarNuevoTurnoADaniela(turno).catch(err =>
      console.error('Error notificando nuevo turno a Daniela:', err.message)
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
//
// Los servicios que sean compatibles entre sí (ej. PRP + Pies, configurado en el
// servicio ancla como intercalable/servicios_compatibles) NO se encadenan uno detrás
// del otro: comparten el mismo horario, sin sumar tiempo al bloque.
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

    // Antelacion minima. Solo en la web, igual que en el turno simple.
    if (demasiadoCerca(fecha, hora_inicio)) {
      return res.status(400).json({ error: errorAntelacion().publico });
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
 
    // Separar los servicios en "secuenciales" (se encadenan uno atrás del otro) e
    // "intercalados" (comparten horario con su servicio ancla, sin sumar tiempo)
    // Profesional unica de la reserva + plata congelada por servicio. Se
    // resuelve ANTES de armar el bloque para que una reserva que mezcla
    // profesionales falle antes de calcular horarios.
    const { profesionalId, plataPorServicioId } = await resolverProfesionalYPlata(items);

    const { secuenciales, intercalados, duracionEfectivaPorId } = resolverBloqueConIntercalados(items);
 
    const grupoReserva = uuidv4();
    const tokenExpires = new Date();
    tokenExpires.setDate(tokenExpires.getDate() + 30);
 
    let cursor = hora_inicio;
    let ordenGrupo = 0;
    const turnosData = [];
    const horarioPorServicioId = {};
 
    // 1. Encadenar los secuenciales (usando la duración "efectiva" de cada uno,
    //    que para un ancla ya viene estirada para cubrir a su intercalado)
    secuenciales.forEach(item => {
      const inicio = cursor;
      const finReal = calcularHoraFin(inicio, item.duracion); // hora_fin propia del servicio
      const finEfectivo = calcularHoraFin(inicio, duracionEfectivaPorId[item.servicio.id]);
      horarioPorServicioId[item.servicio.id] = { inicio, fin: finEfectivo };
      ordenGrupo++;
      turnosData.push({
        cliente_nombre: nombre.trim(),
        cliente_apellido: apellido.trim(),
        cliente_telefono: telLimpio,
        servicio_id: item.servicio.id,
        profesional_id: profesionalId,
        ...plataPorServicioId[item.servicio.id],
        fecha: new Date(fecha),
        hora_inicio: inicio,
        hora_fin: finReal,
        extras_ids: item.extras.map(e => e.id),
        grupo_reserva: grupoReserva,
        orden_en_grupo: ordenGrupo,
        estado: 'confirmado',
        token_acceso: uuidv4(),
        token_expires_at: tokenExpires
      });
      cursor = finEfectivo;
    });
 
    // 2. Ubicar los intercalados: comparten el horario de su ancla (con el offset configurado)
    intercalados.forEach(({ item, anclaServicioId, offsetMin }) => {
      const anclaHorario = horarioPorServicioId[anclaServicioId];
      const inicio = minutosAHora(horaAMinutos(anclaHorario.inicio) + offsetMin);
      const fin = calcularHoraFin(inicio, item.duracion);
      ordenGrupo++;
      turnosData.push({
        cliente_nombre: nombre.trim(),
        cliente_apellido: apellido.trim(),
        cliente_telefono: telLimpio,
        servicio_id: item.servicio.id,
        profesional_id: profesionalId,
        ...plataPorServicioId[item.servicio.id],
        fecha: new Date(fecha),
        hora_inicio: inicio,
        hora_fin: fin,
        extras_ids: item.extras.map(e => e.id),
        grupo_reserva: grupoReserva,
        orden_en_grupo: ordenGrupo,
        estado: 'confirmado',
        token_acceso: uuidv4(),
        token_expires_at: tokenExpires
      });
    });
 
    const rangoInicio = hora_inicio;
    const rangoFin = cursor; // fin del último secuencial; los intercalados siempre terminan antes o igual
 
    const turnosCreados = await verificarYReservarBloque(turnosData, rangoInicio, rangoFin);
 
    // Ordenar cronológicamente para el mensaje de WhatsApp y la respuesta
    turnosCreados.sort((a, b) => a.hora_inicio.localeCompare(b.hora_inicio));
 
    // Adjuntar extras a cada turno creado (buscando por servicio_id, ya que el orden pudo cambiar)
    turnosCreados.forEach(t => {
      const item = items.find(i => i.servicio.id === t.servicio_id);
      t.extras = item ? item.extras : [];
    });
 
    enviarConfirmacionGrupo(turnosCreados).catch(err =>
      console.error('Error enviando WA de confirmación de grupo:', err.message)
    );
    notificarNuevoTurnoGrupoADaniela(turnosCreados).catch(err =>
      console.error('Error notificando nuevo grupo a Daniela:', err.message)
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
          // Solo a quien espera un servicio de la MISMA profesional: lo que se
          // liberó es un rato de su agenda. Sin este filtro, una cancelación de
          // una profesional le avisaría "se liberó un lugar" a una clienta que
          // espera turno con otra, cuya agenda no se movió.
          where: {
            fecha: primero.fecha,
            franja,
            activo: true,
            notificado: false,
            servicio: { profesional_id: primero.profesional_id }
          },
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
      // Mismo criterio que en la cancelación de grupo: solo la misma profesional.
      where: {
        fecha: turno.fecha,
        franja,
        activo: true,
        notificado: false,
        servicio: { profesional_id: turno.profesional_id }
      },
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
    const { extras, sin_minimo } = req.query;
    const opciones = { respetarAntelacion: sin_minimo !== '1' };
 
    const servicio = await prisma.servicio.findUnique({
      where: { id: parseInt(servicio_id) },
      include: { profesional: { select: { activo: true } } }
    });
    // Un servicio dado de baja, o de una profesional desactivada, no ofrece
    // horarios. Antes este endpoint no chequeaba ni lo uno ni lo otro.
    if (servicio && (!servicio.activo || !servicio.profesional?.activo)) {
      return res.json({ fecha, servicio: servicio.nombre, horarios: [] });
    }
    if (!servicio) {
      return res.status(404).json({ error: 'Servicio no encontrado' });
    }
 
    const extrasValidos = await resolverExtras(extras, parseInt(servicio_id));
    const minutosExtra = extrasValidos.reduce((s, e) => s + (e.minutos_adicionales || 0), 0);
 
    const horarios = await obtenerHorariosDisponibles(
      new Date(fecha),
      servicio.duracion_minutos + minutosExtra,
      parseInt(servicio_id),
      servicio.profesional_id,
      opciones
    );
 
    res.json({ fecha, servicio: servicio.nombre, horarios });
  } catch (err) { next(err); }
});
 
// ── POST /api/turnos/disponibilidad-multi → disponibilidad de un bloque ──
// body: { fecha, servicios: [ { servicio_id, extras: [ids] }, ... ] }
// La duración total ya tiene en cuenta los servicios compatibles entre sí
// (ej. PRP + Pies): esos no suman tiempo, comparten el horario del ancla.
router.post('/disponibilidad-multi', async (req, res, next) => {
  try {
    const { fecha, servicios, sin_minimo } = req.body;
    const opciones = { respetarAntelacion: sin_minimo !== true };
    if (!fecha || !Array.isArray(servicios) || servicios.length === 0) {
      return res.status(400).json({ error: 'Faltan datos (fecha y servicios)' });
    }
 
    const items = [];
    for (const item of servicios) {
      const sid = parseInt(item.servicio_id);
      const servicio = await prisma.servicio.findUnique({
        where: { id: sid },
        include: { profesional: { select: { activo: true } } }
      });
      if (!servicio) {
        return res.status(404).json({ error: `Servicio ${item.servicio_id} no encontrado` });
      }
      if (!servicio.activo || !servicio.profesional?.activo) {
        return res.json({ fecha, duracion_total: 0, horarios: [] });
      }
      const extrasValidos = await resolverExtras(item.extras, sid);
      const minutosExtra = extrasValidos.reduce((s, e) => s + (e.minutos_adicionales || 0), 0);
      items.push({
        servicio,
        extras: extrasValidos,
        duracion: servicio.duracion_minutos + minutosExtra
      });
    }
 
    const { duracionTotal } = resolverBloqueConIntercalados(items);
 
    // Todos los items son de la misma profesional: el frontend no deja
    // combinarlas y lib/reservas.js lo rechaza al reservar. Acá alcanza con
    // tomar la del primero para saber contra qué agenda medir.
    const horarios = await obtenerHorariosDisponiblesBloque(
      new Date(fecha),
      duracionTotal,
      items[0].servicio.profesional_id,
      opciones
    );
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
    if (!servicio || !servicio.activo) {
      return res.status(404).json({ error: 'Servicio no encontrado' });
    }
    // Este endpoint es publico (la clienta entra con su token) y crea el turno
    // nuevo sin pasar por verificarYReservar, asi que no valida disponibilidad.
    // Permitir cambiar a un servicio de OTRA profesional dejaria a la clienta
    // mover su turno a una agenda ajena, en un horario que esa profesional
    // quiza no trabaje, y arrastrando la comision. Para cambiar de profesional
    // hay que cancelar y reservar de nuevo.
    if (servicio.profesional_id !== turno.profesional_id) {
      return res.status(400).json({
        error: 'Para cambiar a un servicio de otra profesional hay que reservar un turno nuevo'
      });
    }
    const fecha = nueva_fecha || turno.fecha.toISOString().split('T')[0];
    const horaInicio = nueva_hora_inicio || turno.hora_inicio;
    const horaFin = calcularHoraFin(horaInicio, servicio.duracion_minutos);

    // Si cambio el servicio, la profesional y la comision tienen que cambiar
    // con el: si no, el turno queda con la profesional del servicio viejo y la
    // liquidacion miente. El turno recreado no arrastra extras, asi que la
    // plata se calcula solo sobre el servicio.
    const { profesionalId, plataPorServicioId } = await resolverProfesionalYPlata([
      { servicio, extras: [] }
    ]);
 
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
          profesional_id: profesionalId,
          ...plataPorServicioId[servicio.id],
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
    notificarModificacionADaniela(turno, turnoActualizado).catch(err =>
      console.error('Error notificando modificación a Daniela:', err.message)
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
      notificarCancelacionGrupoADaniela(grupo).catch(err =>
        console.error('Error notificando cancelación de grupo a Daniela:', err.message)
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
    notificarCancelacionADaniela(turno).catch(err =>
      console.error('Error notificando cancelación a Daniela:', err.message)
    );
 
    res.json({ success: true });
  } catch (err) { next(err); }
});
 
module.exports = router;
 
