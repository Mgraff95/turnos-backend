
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const prisma = require('../lib/prisma');
const {
  resolverExtras,
  resolverProfesionalYPlata,
  plataDelTurno,
  plataReasignada,
  cargarProfesionalActiva
} = require('../lib/reservas');
const { cambiosDeTurno, duracionConExtras, puedeReasignar, MENSAJES_EDICION } = require('../lib/edicion');
const { authAdmin } = require('../middleware/auth');
const {
  calcularHoraFin,
  verificarYReservar,
  verificarYActualizar,
  verificarYReservarBloque,
  resolverBloqueConIntercalados,
  obtenerHorariosDisponibles,
  horaAMinutos,
  minutosAHora
} = require('../lib/availability');
const { enviarConfirmacion, enviarConfirmacionGrupo } = require('../services/whatsapp');
// Los avisos del panel van SOLO a la profesional del turno: el movimiento lo
// hizo Daniela, avisarle de lo que acaba de hacer no le sirve de nada. Si el
// turno es suyo, no sale ningún mensaje.
const {
  avisarNuevoTurno,
  avisarNuevoTurnoGrupo,
  avisarCancelacion,
  avisarModificacion
} = require('../lib/avisos');
const SOLO_LA_PROFESIONAL = { incluirEstudio: false };
 
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
      // La profesional viaja con el turno: la agenda la usa para teñir y para
      // mostrar el nombre, y Métricas para decidir si el ingreso del estudio es
      // el precio completo o solo la comisión.
      include: {
        servicio: true,
        profesional: { select: { id: true, nombre: true, comision_pct_default: true } }
      },
      orderBy: [{ fecha: 'asc' }, { hora_inicio: 'asc' }]
    });
 
    await adjuntarExtras(turnos);
    res.json(turnos);
  } catch (err) { next(err); }
});
 
// ── Admin: Crear turno manual (1 servicio) ─────
router.post('/turnos', authAdmin, async (req, res, next) => {
  try {
    const { nombre, apellido, telefono, servicio_id, fecha, hora_inicio, extras, notificar } = req.body;
 
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
 
    // Resolver extras elegidos (suman tiempo y precio), igual que en la reserva pública
    const extrasValidos = await resolverExtras(extras, parseInt(servicio_id));
    const minutosExtra = extrasValidos.reduce((s, e) => s + (e.minutos_adicionales || 0), 0);
    const horaFin = calcularHoraFin(hora_inicio, servicio.duracion_minutos + minutosExtra);
 
    const tokenExpires = new Date();
    tokenExpires.setDate(tokenExpires.getDate() + 30);
 
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
      token_expires_at: tokenExpires,
      origen: 'manual'
    });
 
    // Adjuntar los extras al objeto para el mensaje de WhatsApp
    turno.extras = extrasValidos;
 
    // Enviar WhatsApp (no bloqueante), salvo que el admin haya destildado la notificación.
    // Default: notificar (si no viene el campo, o viene true, se notifica igual que antes).
    const debeNotificar = notificar !== false;
    if (debeNotificar) {
      enviarConfirmacion(turno).catch(err =>
        console.error('Error enviando WA:', err.message)
      );
    }

    // Fuera del if a propósito: el check del panel dice "avisar por WhatsApp a
    // la clienta". Si Daniela lo destilda porque la clienta ya está avisada, la
    // profesional tiene que enterarse igual de que le agendaron un turno.
    avisarNuevoTurno(turno, SOLO_LA_PROFESIONAL).catch(err =>
      console.error('Error avisando el turno nuevo a la profesional:', err.message)
    );

    res.status(201).json({ success: true, turno, notificado: debeNotificar });
  } catch (err) {
    if (err.message === 'HORARIO_NO_DISPONIBLE') {
      return res.status(409).json({ error: 'Ese horario ya no está disponible.' });
    }
    next(err);
  }
});
 
// ── Admin: Crear turno manual con VARIOS servicios (bloque continuo) ──
// body: { nombre, apellido, telefono, fecha, hora_inicio,
//         servicios: [ { servicio_id, extras: [ids] }, ... ], notificar }
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
 
    // Resolver cada servicio + sus extras, en el orden enviado
    const items = [];
    for (const item of servicios) {
      // Acepta tanto { servicio_id, extras } como un id suelto (compatibilidad hacia atrás)
      const servicioIdRaw = typeof item === 'object' ? item.servicio_id : item;
      const extrasInput = typeof item === 'object' ? item.extras : null;
      const sid = parseInt(servicioIdRaw);
      const servicio = await prisma.servicio.findUnique({ where: { id: sid } });
      if (!servicio || !servicio.activo) {
        return res.status(404).json({ error: `Servicio ${servicioIdRaw} no encontrado` });
      }
      const extrasValidos = await resolverExtras(extrasInput, sid);
      const minutosExtra = extrasValidos.reduce((s, e) => s + (e.minutos_adicionales || 0), 0);
      items.push({ servicio, extras: extrasValidos, duracion: servicio.duracion_minutos + minutosExtra });
    }
 
    // Separar en secuenciales / intercalados (misma lógica que la reserva pública)
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
        token_expires_at: tokenExpires,
        origen: 'manual'
      });
    });
 
    const rangoInicio = hora_inicio;
    const rangoFin = cursor;
 
    const turnosCreados = await verificarYReservarBloque(turnosData, rangoInicio, rangoFin);
 
    // Ordenar cronológicamente para el mensaje de WhatsApp y la respuesta
    turnosCreados.sort((a, b) => a.hora_inicio.localeCompare(b.hora_inicio));
    // Adjuntar extras a cada turno creado (buscando por servicio_id, ya que el orden pudo cambiar)
    turnosCreados.forEach(t => {
      const item = items.find(i => i.servicio.id === t.servicio_id);
      t.extras = item ? item.extras : [];
    });
 
    const debeNotificar = notificar !== false;
    if (debeNotificar) {
      enviarConfirmacionGrupo(turnosCreados).catch(err =>
        console.error('Error enviando WA de grupo (admin):', err.message)
      );
    }

    avisarNuevoTurnoGrupo(turnosCreados, SOLO_LA_PROFESIONAL).catch(err =>
      console.error('Error avisando la reserva nueva a la profesional:', err.message)
    );

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
    // `profesional_id` es opcional: sin él, el turno se queda con la dueña del
    // servicio, que es el comportamiento de siempre.
    const { nombre, apellido, telefono, servicio_id, fecha, hora_inicio, profesional_id } = req.body;

    // El servicio viene incluido porque si el cambio le mueve el turno de
    // profesional, el aviso a la que lo pierde nombra el servicio que tenía.
    const turnoActual = await prisma.turno.findUnique({
      where: { id: turnoId },
      include: { servicio: true }
    });
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
 
    // Quien atiende: la del body si vino, y si no la dueña del servicio. Un
    // `profesional_id` que no es un número no se interpreta como "no vino": es
    // un pedido mal armado y se rechaza.
    const sinProfesional = profesional_id === undefined || profesional_id === null || profesional_id === '';
    const profesionalPedida = sinProfesional ? servicio.profesional_id : parseInt(profesional_id);
    if (!Number.isInteger(profesionalPedida)) {
      return res.status(400).json({ error: 'Profesional inválida' });
    }

    // La guarda mira la profesional EFECTIVA, no si el campo vino en el body:
    // cambiarle el servicio a uno de otra dueña también mueve el turno de
    // agenda. Partir un bloque continuo entre dos agendas deja algo que el
    // camino de alta no permite crear; el resto de la edición sigue abierta.
    const permiso = puedeReasignar(turnoActual, profesionalPedida);
    if (!permiso.ok) {
      return res.status(409).json({ error: MENSAJES_EDICION[permiso.motivo] });
    }

    // Dejar las cosas como están nunca puede fallar: si la profesional del turno
    // se desactivó, sus turnos históricos tienen que seguir editándose. El
    // chequeo de `activo` corre solo cuando se le ASIGNA el turno a alguien.
    let profesional;
    try {
      profesional = profesionalPedida === turnoActual.profesional_id
        ? await prisma.profesional.findUnique({ where: { id: profesionalPedida } })
        : await cargarProfesionalActiva(profesionalPedida);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.publico || 'Profesional no disponible' });
      throw err;
    }
    if (!profesional) return res.status(404).json({ error: 'Profesional no encontrada' });

    const cambios = cambiosDeTurno(turnoActual, {
      servicio_id: parseInt(servicio_id),
      profesional_id: profesional.id,
      fecha,
      hora_inicio
    });

    // Dos lecturas distintas de los extras, a propósito:
    //
    // - Si cambió el servicio, se filtran contra el nuevo: los que no aplican
    //   dejan de contar en el precio y salen de la lista guardada.
    // - Si no cambió, se leen TAL COMO ESTÁN, sin filtrar por `activo`. Un extra
    //   dado de baja después de la reserva sigue ocupando los minutos que ocupa:
    //   filtrarlo le acortaba el hora_fin al turno y liberaba tiempo en el que
    //   hay una clienta sentada.
    const extrasDelTurno = cambios.servicio
      ? await resolverExtras(turnoActual.extras_ids, parseInt(servicio_id))
      : (turnoActual.extras_ids?.length
        ? await prisma.extra.findMany({ where: { id: { in: turnoActual.extras_ids } } })
        : []);

    // La plata se recongela SOLO si cambió qué se hace o quién lo hace, y ni
    // siquiera entonces se recalcula entera: si el servicio es el mismo, el
    // `precio_base` es la foto de lo que la clienta aceptó y no se toca —lo
    // único que cambia de manos es la comisión—. Antes se recalculaba todo en
    // toda edición, así que corregir un apellido movía el precio del turno a los
    // valores de hoy, y con él una liquidación ya compartida.
    const plata = !cambios.recalcularPlata
      ? {}
      : cambios.servicio
        ? plataDelTurno(servicio, profesional, extrasDelTurno)
        : plataReasignada(turnoActual, servicio, profesional, extrasDelTurno);

    // La lista guardada se actualiza solo cuando cambió el servicio, que es
    // cuando algún extra pudo quedar afuera del precio.
    const extras = cambios.servicio ? { extras_ids: extrasDelTurno.map(e => e.id) } : {};

    let turno;
    try {
      turno = await verificarYActualizar(turnoId, {
        cliente_nombre: nombre.trim(),
        cliente_apellido: apellido.trim(),
        cliente_telefono: telLimpio,
        servicio_id: parseInt(servicio_id),
        profesional_id: profesional.id,
        ...plata,
        ...extras,
        fecha: new Date(fecha),
        hora_inicio,
        hora_fin: calcularHoraFin(hora_inicio, duracionConExtras(servicio, extrasDelTurno))
      });
    } catch (err) {
      if (err.message === 'HORARIO_NO_DISPONIBLE') {
        return res.status(409).json({ error: `Ese horario ya está ocupado para ${profesional.nombre}.` });
      }
      throw err;
    }
 
    // A la clienta solo se le avisa de lo que la afecta: servicio, fecha u hora.
    // Una reasignación es organización interna del estudio y no le llega.
    if (cambios.avisarClienta) {
      const { enviarMensaje } = require('../services/whatsapp');

      const queCambioLista = [];
      if (cambios.servicio) queCambioLista.push('el servicio');
      if (cambios.fecha) queCambioLista.push('la fecha');
      if (cambios.hora) queCambioLista.push('el horario');

      let queCambio;
      if (queCambioLista.length === 1) queCambio = queCambioLista[0];
      else if (queCambioLista.length === 2) queCambio = `${queCambioLista[0]} y ${queCambioLista[1]}`;
      else queCambio = `${queCambioLista.slice(0, -1).join(', ')} y ${queCambioLista[queCambioLista.length - 1]}`;
 
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

    // Fuera del if de la clienta: una reasignación no le llega a ella, pero las
    // dos profesionales tienen que enterarse. Si cambió la profesional,
    // avisarModificacion lo resuelve como una baja y un alta.
    if (cambios.avisarProfesionales) {
      avisarModificacion(turnoActual, turno, SOLO_LA_PROFESIONAL).catch(err =>
        console.error('Error avisando la modificación a la profesional:', err.message)
      );
    }

    res.json({ success: true, turno });
  } catch (err) { next(err); }
});
 
// ── Disponibilidad de una profesional explícita ──
//
// El endpoint público deriva la profesional del servicio, así que no sirve para
// preguntar "qué huecos tiene Noemí para un servicio de Daniela", que es lo que
// el panel necesita para reasignar un turno.
//
// Va acá, con authAdmin, y no como un parámetro más del público: ese endpoint no
// tiene auth, y dejar elegir la profesional ahí permitiría a cualquiera cruzar
// las agendas del estudio.
//
// `respetarAntelacion: false` siempre: Daniela no está sujeta a la ventana de
// 24 horas, puede rellenar un hueco de hoy.
router.get('/disponibilidad/:fecha/:servicio_id/:profesional_id', authAdmin, async (req, res, next) => {
  try {
    const { fecha, servicio_id, profesional_id } = req.params;
    const servicioId = parseInt(servicio_id);
    const profesionalId = parseInt(profesional_id);

    const servicio = await prisma.servicio.findUnique({ where: { id: servicioId } });
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });

    const profesional = await prisma.profesional.findUnique({
      where: { id: profesionalId },
      select: { id: true, nombre: true, activo: true }
    });
    if (!profesional) return res.status(404).json({ error: 'Profesional no encontrada' });

    // Un servicio dado de baja o una profesional desactivada no ofrecen nada,
    // igual que en el endpoint público.
    if (!servicio.activo || !profesional.activo) {
      return res.json({ fecha, servicio: servicio.nombre, profesional: profesional.nombre, horarios: [] });
    }

    const extras = await resolverExtras(req.query.extras, servicioId);

    // Al editar un turno, ese turno no puede taparse su propio horario. Importa
    // sobre todo con los servicios de camilla: el turno que se está moviendo
    // ocupa la camilla, así que sin excluirlo su propia hora desaparece de la
    // agenda de la otra profesional y la reasignación se vuelve imposible.
    const excluir = parseInt(req.query.excluir_turno_id);
    const excluirTurnoIds = Number.isInteger(excluir) ? [excluir] : [];

    const horarios = await obtenerHorariosDisponibles(
      new Date(fecha),
      duracionConExtras(servicio, extras),
      servicioId,
      profesionalId,
      { respetarAntelacion: false, usaCamilla: servicio.usa_camilla === true, excluirTurnoIds }
    );

    res.json({ fecha, servicio: servicio.nombre, profesional: profesional.nombre, horarios });
  } catch (err) { next(err); }
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
 
// ── Admin: marcar un turno como liquidable o no ──
// Se apaga cuando la clienta no vino: el turno sigue confirmado (ocupó el
// horario, cuenta en su histórico) pero no entra en la liquidación, para no
// cobrarle comisión a la profesional por un servicio que no hizo.
//
// Endpoint aparte del PATCH /turnos/:id general, que reagenda y revalida
// disponibilidad: acá no hay nada que revalidar.
router.patch('/turnos/:id/liquidable', authAdmin, async (req, res, next) => {
  try {
    const { liquidable } = req.body;
    if (typeof liquidable !== 'boolean') {
      return res.status(400).json({ error: 'liquidable tiene que ser true o false' });
    }
    const turno = await prisma.turno.update({
      where: { id: parseInt(req.params.id) },
      data: { liquidable }
    });
    res.json({ success: true, liquidable: turno.liquidable });
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

    avisarCancelacion(turno, SOLO_LA_PROFESIONAL).catch(err =>
      console.error('Error avisando la cancelación a la profesional:', err.message)
    );

    res.json({ success: true });
  } catch (err) { next(err); }
});
 
module.exports = router;
 
