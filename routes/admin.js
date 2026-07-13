const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const prisma = require('../lib/prisma');
const { authAdmin } = require('../middleware/auth');
const {
  calcularHoraFin,
  verificarYReservar,
  verificarYActualizar,
  verificarYReservarBloque,
  resolverBloqueConIntercalados,
  horaAMinutos,
  minutosAHora
} = require('../lib/availability');
const { enviarConfirmacion, enviarConfirmacionGrupo } = require('../services/whatsapp');

// Adjunta a cada turno el detalle de sus extras (nombre, precio, minutos),
// resolviendo los extras_ids con una sola consulta para toda la lista.
async function adjuntarExtras(turnos) {
  const lista = Array.isArray(turnos) ? turnos : [turnos];
  const todosIds = [...new Set(lista.flatMap(t => t.extras_ids || []))];
  if (todosIds.length === 0) {
    lista.forEach(t => { t.extras = []; });
    return turnos;
  }
  const extras = await prisma.extra.findMany({ where: { id: { in: todosIds } } });
  const mapa = new Map(extras.map(e => [e.id, e]));
  lista.forEach(t => {
    t.extras = (t.extras_ids || []).map(id => mapa.get(id)).filter(Boolean);
  });
  return turnos;
}

// ── Login admin ────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Faltan campos: email, password' });
    }

    const admin = await prisma.usuarioAdmin.findUnique({ where: { email } });

    if (!admin || !admin.activo) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const passwordValido = await bcrypt.compare(password, admin.password_hash);
    if (!passwordValido) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    await prisma.usuarioAdmin.update({
      where: { id: admin.id },
      data: { last_login: new Date() }
    });

    const token = jwt.sign(
      { id: admin.id, email: admin.email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: { id: admin.id, email: admin.email, nombre: admin.nombre }
    });
  } catch (err) { next(err); }
});

// ── Dashboard: todos los turnos ────────────────
router.get('/turnos', authAdmin, async (req, res, next) => {
  try {
    const { estado, desde, hasta } = req.query;

    const where = {};
    if (estado) where.estado = estado;
    if (desde || hasta) {
      where.fecha = {};
      if (desde) where.fecha.gte = new Date(desde);
      if (hasta) where.fecha.lte = new Date(hasta);
    }

    const turnos = await prisma.turno.findMany({
      where,
      include: { servicio: true },
      orderBy: [{ fecha: 'asc' }, { hora_inicio: 'asc' }]
    });

    await adjuntarExtras(turnos);
    res.json(turnos);
  } catch (err) { next(err); }
});

// ── Admin: Crear turno manual (1 servicio) ─────
router.post('/turnos', authAdmin, async (req, res, next) => {
  try {
    const { nombre, apellido, telefono, servicio_id, fecha, hora_inicio, notificar } = req.body;

    if (!nombre || !apellido || !telefono || !servicio_id || !fecha || !hora_inicio) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const telLimpio = telefono.replace(/\D/g, '');

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
      token_expires_at: tokenExpires,
      origen: 'manual'
    });

    // Enviar WhatsApp (no bloqueante), salvo que el admin haya destildado la notificación.
    // Default: notificar (si no viene el campo, o viene true, se notifica igual que antes).
    const debeNotificar = notificar !== false;
    if (debeNotificar) {
      enviarConfirmacion(turno).catch(err =>
        console.error('Error enviando WA:', err.message)
      );
    }

    res.status(201).json({ success: true, turno, notificado: debeNotificar });
  } catch (err) {
    if (err.message === 'HORARIO_NO_DISPONIBLE') {
      return res.status(409).json({ error: 'Ese horario ya no está disponible.' });
    }
    next(err);
  }
});

// ── Admin: Crear turno manual con VARIOS servicios (bloque continuo) ──
// body: { nombre, apellido, telefono, fecha, hora_inicio, servicios: [servicio_id, servicio_id, ...], notificar }
// Reutiliza la misma lógica de intercalado que /api/turnos/multi (público): si dos
// servicios elegidos son compatibles entre sí (ej. PRP + Pies), no se encadenan uno
// detrás del otro — comparten horario, sin sumar tiempo al bloque.
router.post('/turnos/multi', authAdmin, async (req, res, next) => {
  try {
    const { nombre, apellido, telefono, fecha, hora_inicio, servicios, notificar } = req.body;

    if (!nombre || !apellido || !telefono || !fecha || !hora_inicio) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }
    if (!Array.isArray(servicios) || servicios.length < 2) {
      return res.status(400).json({ error: 'Un turno con varios servicios necesita al menos 2 servicios' });
    }

    const telLimpio = telefono.replace(/\D/g, '');

    // Resolver cada servicio, en el orden enviado
    const items = [];
    for (const servicioIdRaw of servicios) {
      const sid = parseInt(servicioIdRaw);
      const servicio = await prisma.servicio.findUnique({ where: { id: sid } });
      if (!servicio || !servicio.activo) {
        return res.status(404).json({ error: `Servicio ${servicioIdRaw} no encontrado` });
      }
      items.push({ servicio, extras: [], duracion: servicio.duracion_minutos });
    }

    // Separar en secuenciales / intercalados (misma lógica que la reserva pública)
    const { secuenciales, intercalados, duracionEfectivaPorId } = resolverBloqueConIntercalados(items);

    const grupoReserva = uuidv4();
    const tokenExpires = new Date();
    tokenExpires.setDate(tokenExpires.getDate() + 30);

    let cursor = hora_inicio;
    let ordenGrupo = 0;
    const turnosData = [];
    const horarioPorServicioId = {};

    // 1. Encadenar los secuenciales
    secuenciales.forEach(item => {
      const inicio = cursor;
      const finReal = calcularHoraFin(inicio, item.duracion);
      const finEfectivo = calcularHoraFin(inicio, duracionEfectivaPorId[item.servicio.id]);
      horarioPorServicioId[item.servicio.id] = { inicio, fin: finEfectivo };
      ordenGrupo++;
      turnosData.push({
        cliente_nombre: nombre.trim(),
        cliente_apellido: apellido.trim(),
        cliente_telefono: telLimpio,
        servicio_id: item.servicio.id,
        fecha: new Date(fecha),
        hora_inicio: inicio,
        hora_fin: finReal,
        grupo_reserva: grupoReserva,
        orden_en_grupo: ordenGrupo,
        estado: 'confirmado',
        token_acceso: uuidv4(),
        token_expires_at: tokenExpires,
        origen: 'manual'
      });
      cursor = finEfectivo;
    });

    // 2. Ubicar los intercalados: comparten horario con su ancla
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
        fecha: new Date(fecha),
        hora_inicio: inicio,
        hora_fin: fin,
        grupo_reserva: grupoReserva,
        orden_en_grupo: ordenGrupo,
        estado: 'confirmado',
        token_acceso: uuidv4(),
        token_expires_at: tokenExpires,
        origen: 'manual'
      });
    });

    const rangoInicio = hora_inicio;
    const rangoFin = cursor;

    const turnosCreados = await verificarYReservarBloque(turnosData, rangoInicio, rangoFin);

    // Ordenar cronológicamente para el mensaje de WhatsApp y la respuesta
    turnosCreados.sort((a, b) => a.hora_inicio.localeCompare(b.hora_inicio));
    turnosCreados.forEach(t => { t.extras = []; });

    const debeNotificar = notificar !== false;
    if (debeNotificar) {
      enviarConfirmacionGrupo(turnosCreados).catch(err =>
        console.error('Error enviando WA de grupo (admin):', err.message)
      );
    }

    res.status(201).json({
      success: true,
      grupo_reserva: grupoReserva,
      hora_inicio: rangoInicio,
      hora_fin: rangoFin,
      turnos: turnosCreados,
      notificado: debeNotificar
    });
  } catch (err) {
    if (err.message === 'HORARIO_NO_DISPONIBLE') {
      return res.status(409).json({ error: 'Ese horario ya no está disponible para todos los servicios.' });
    }
    next(err);
  }
});

// ── Admin: Editar turno ────────────────────────
router.patch('/turnos/:id', authAdmin, async (req, res, next) => {
  try {
    const turnoId = parseInt(req.params.id);
    const { nombre, apellido, telefono, servicio_id, fecha, hora_inicio } = req.body;

    const turnoActual = await prisma.turno.findUnique({ where: { id: turnoId } });
    if (!turnoActual) return res.status(404).json({ error: 'Turno no encontrado' });
    if (turnoActual.estado !== 'confirmado') {
      return res.status(400).json({ error: 'Solo se pueden editar turnos confirmados' });
    }

    if (!nombre || !apellido || !telefono || !servicio_id || !fecha || !hora_inicio) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const telLimpio = telefono.replace(/\D/g, '');

    const servicio = await prisma.servicio.findUnique({
      where: { id: parseInt(servicio_id) }
    });
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });

    // Detectar qué cambió (servicio, fecha u horario) comparando con el turno actual
    const fechaAntes = turnoActual.fecha.toISOString().split('T')[0];
    const cambioServicio = parseInt(servicio_id) !== turnoActual.servicio_id;
    const cambioFecha = fecha !== fechaAntes;
    const cambioHora = hora_inicio !== turnoActual.hora_inicio;

    const horaFin = calcularHoraFin(hora_inicio, servicio.duracion_minutos);

    const turno = await verificarYActualizar(turnoId, {
      cliente_nombre: nombre.trim(),
      cliente_apellido: apellido.trim(),
      cliente_telefono: telLimpio,
      servicio_id: parseInt(servicio_id),
      fecha: new Date(fecha),
      hora_inicio,
      hora_fin: horaFin
    });

    // Si cambió el servicio, la fecha o el horario, avisar al cliente por WhatsApp
    if (cambioServicio || cambioFecha || cambioHora) {
      const { enviarMensaje } = require('../services/whatsapp');

      const cambios = [];
      if (cambioServicio) cambios.push('el servicio');
      if (cambioFecha) cambios.push('la fecha');
      if (cambioHora) cambios.push('el horario');

      let queCambio;
      if (cambios.length === 1) queCambio = cambios[0];
      else if (cambios.length === 2) queCambio = `${cambios[0]} y ${cambios[1]}`;
      else queCambio = `${cambios.slice(0, -1).join(', ')} y ${cambios[cambios.length - 1]}`;

      const fechaStr = new Date(turno.fecha).toLocaleDateString('es-AR', { weekday: 'long', day: '2-digit', month: '2-digit' });

      const mensaje =
        `Hola ${turno.cliente_nombre} 👋\n\n` +
        `Te avisamos que ${queCambio} de tu turno fue modificado por el estudio.\n\n` +
        `Tu turno queda así:\n` +
        `📅 ${fechaStr}\n` +
        `⏰ ${turno.hora_inicio} hs\n` +
        `💅 ${turno.servicio.nombre}\n\n` +
        `Cualquier duda, escribinos. ¡Te esperamos! 💅`;

      enviarMensaje(turno.cliente_telefono, mensaje).catch(err =>
        console.error('Error enviando WA de modificación (admin):', err.message)
      );
    }

    res.json({ success: true, turno });
  } catch (err) {
    if (err.message === 'HORARIO_NO_DISPONIBLE') {
      return res.status(409).json({ error: 'Ese horario ya no está disponible.' });
    }
    next(err);
  }
});

// ── Recordatorios pendientes ───────────────────
router.get('/recordatorios-pendientes', authAdmin, async (req, res, next) => {
  try {
    const manana = new Date();
    manana.setDate(manana.getDate() + 1);
    const fechaManana = manana.toISOString().split('T')[0];

    const turnos = await prisma.turno.findMany({
      where: { fecha: new Date(fechaManana), estado: 'confirmado' },
      include: { servicio: true },
      orderBy: { hora_inicio: 'asc' }
    });
    res.json(turnos);
  } catch (err) { next(err); }
});
// ── TEST: Disparar recordatorio manual ─────────
router.post('/test-recordatorio/:turnoId', authAdmin, async (req, res, next) => {
  try {
    const { enviarRecordatorio } = require('../services/whatsapp');
    const turno = await prisma.turno.findUnique({
      where: { id: parseInt(req.params.turnoId) },
      include: { servicio: true }
    });
    if (!turno) return res.status(404).json({ error: 'Turno no encontrado' });

    const enviado = await enviarRecordatorio(turno);
    if (enviado) {
      await prisma.turno.update({
        where: { id: turno.id },
        data: { recordatorio_enviado: true }
      });
    }
    res.json({ success: enviado, turno_id: turno.id });
  } catch (err) { next(err); }
});

// ── Admin: Cancelar turno ──────────────────────
router.delete('/turnos/:id', authAdmin, async (req, res, next) => {
  try {
    const turno = await prisma.turno.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { servicio: true }
    });

    if (!turno) return res.status(404).json({ error: 'Turno no encontrado' });
    if (turno.estado !== 'confirmado') return res.status(400).json({ error: 'Solo se pueden cancelar turnos confirmados' });

    await prisma.turno.update({
      where: { id: turno.id },
      data: { estado: 'cancelado' }
    });

    // Notificar al cliente por WhatsApp
    const { enviarMensaje } = require('../services/whatsapp');
    const fechaStr = new Date(turno.fecha).toLocaleDateString('es-AR', { weekday: 'long', day: '2-digit', month: '2-digit' });
    await enviarMensaje(turno.cliente_telefono,
      `Hola ${turno.cliente_nombre} 👋\n\n` +
      `Tu turno del ${fechaStr} a las ${turno.hora_inicio} hs fue cancelado por el estudio.\n\n` +
      `Podés reprogramarlo cuando quieras desde acá:\n` +
      `${process.env.FRONTEND_URL}\n\n` +
      `¡Disculpá los inconvenientes! 💅`
    );

    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
