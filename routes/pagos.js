const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const prisma = require('../lib/prisma');
const { calcularMonto, obtenerConfigPago } = require('../lib/pagos');
const { construirTurnosDeReserva } = require('../lib/reservas');
const { verificarYReservar, verificarYReservarBloque, whereHoldsActivos } = require('../lib/availability');
const { crearPreferencia, validarFirmaWebhook, estaConfigurado } = require('../services/mercadopago');
const { procesarNotificacionPago } = require('../lib/pagos-proceso');

// Traduce los errores del constructor de reservas a respuestas HTTP.
function responderErrorReserva(res, err) {
  const mapa = {
    TELEFONO_INVALIDO: [400, 'Teléfono inválido. Ingresá 10 dígitos (ej: 1123456789)'],
    SIN_SERVICIOS: [400, 'No se indicó ningún servicio'],
    SERVICIO_INVALIDO: [400, 'Servicio inválido'],
    SERVICIO_NO_ENCONTRADO: [404, 'Servicio no encontrado']
  };
  const entrada = mapa[err.message];
  if (!entrada) return false;
  res.status(entrada[0]).json({ error: entrada[1] });
  return true;
}

// ── POST /api/pagos/cotizar → cuánto tiene que abonar la clienta ──
// Público. No crea nada: sirve para mostrarle el monto ANTES de mandarla a pagar.
//
// body: { telefono, servicio_id, extras }                          (turno simple)
//    o: { telefono, servicios: [ { servicio_id, extras }, ... ] }  (reserva múltiple)
router.post('/cotizar', async (req, res, next) => {
  try {
    const { telefono, servicio_id, extras, servicios } = req.body;
    const cotizacion = await calcularMonto({ telefono, servicio_id, extras, servicios });
    res.json(cotizacion);
  } catch (err) {
    if (responderErrorReserva(res, err)) return;
    next(err);
  }
});

// ── POST /api/pagos/checkout → congelar el slot y abrir el pago ──
// Público. Recibe el mismo payload que POST /api/turnos o /api/turnos/multi.
//
// 1. valida y arma los turnos (una sola vez, y se guardan en el hold)
// 2. calcula el monto EN EL SERVIDOR
// 3. crea la ReservaPendiente dentro de una transacción, validando disponibilidad
// 4. crea la preferencia en Mercado Pago
//
// Responde { external_ref, init_point, monto, tipo, expira_at }.
router.post('/checkout', async (req, res, next) => {
  let holdCreado = null;
  try {
    const { nombre, apellido, telefono, fecha, hora_inicio, servicio_id, extras, servicios } = req.body;

    if (!nombre || !apellido || !telefono || !fecha || !hora_inicio) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    // Normalizar a la forma de lista, igual que hace la cotización
    const listaServicios = Array.isArray(servicios) && servicios.length > 0
      ? servicios
      : (servicio_id !== undefined ? [{ servicio_id, extras }] : []);

    // 1. Monto (siempre calculado acá, nunca recibido del frontend)
    const cotizacion = await calcularMonto({ telefono, servicios: listaServicios });
    if (!cotizacion.requiere_pago) {
      // El cobro está apagado: que el frontend siga por el flujo de siempre.
      return res.json({ requiere_pago: false, motivo: cotizacion.motivo });
    }

    if (!estaConfigurado()) {
      return res.status(503).json({
        error: 'No podemos procesar pagos en este momento. Escribinos por WhatsApp y te tomamos el turno.'
      });
    }

    // 2. Armar los turnos una única vez. Lo que se guarda acá es exactamente lo
    //    que se va a crear cuando el pago se apruebe.
    const reserva = await construirTurnosDeReserva({
      nombre, apellido, telefono, fecha, hora_inicio,
      servicios: listaServicios,
      origen: 'web'
    });

    const config = await obtenerConfigPago();
    const externalRef = uuidv4();
    const expiraAt = new Date(Date.now() + config.hold_minutos * 60 * 1000);

    // 3. Congelar el slot. La validación de disponibilidad y la creación del
    //    hold van en la misma transacción, para que dos clientas no puedan
    //    congelar el mismo horario a la vez.
    holdCreado = await prisma.$transaction(async (tx) => {
      const fechaDate = new Date(fecha);

      // ¿Hay un turno confirmado pisando el rango?
      const turnoEnConflicto = await tx.turno.findFirst({
        where: {
          fecha: fechaDate,
          estado: 'confirmado',
          OR: [
            { hora_inicio: { lte: reserva.rangoInicio }, hora_fin: { gt: reserva.rangoInicio } },
            { hora_inicio: { lt: reserva.rangoFin }, hora_fin: { gte: reserva.rangoFin } },
            { hora_inicio: { gte: reserva.rangoInicio }, hora_fin: { lte: reserva.rangoFin } }
          ]
        },
        select: { id: true }
      });
      if (turnoEnConflicto) throw new Error('HORARIO_NO_DISPONIBLE');

      // ¿Y otro hold activo?
      const holdEnConflicto = await tx.reservaPendiente.findFirst({
        where: {
          ...whereHoldsActivos(fechaDate),
          OR: [
            { hora_inicio: { lte: reserva.rangoInicio }, hora_fin: { gt: reserva.rangoInicio } },
            { hora_inicio: { lt: reserva.rangoFin }, hora_fin: { gte: reserva.rangoFin } },
            { hora_inicio: { gte: reserva.rangoInicio }, hora_fin: { lte: reserva.rangoFin } }
          ]
        },
        select: { id: true }
      });
      if (holdEnConflicto) throw new Error('HORARIO_NO_DISPONIBLE');

      return tx.reservaPendiente.create({
        data: {
          external_ref: externalRef,
          cliente_nombre: reserva.turnosData[0].cliente_nombre,
          cliente_apellido: reserva.turnosData[0].cliente_apellido,
          cliente_telefono: reserva.turnosData[0].cliente_telefono,
          fecha: fechaDate,
          hora_inicio: reserva.rangoInicio,
          hora_fin: reserva.rangoFin,
          payload: {
            turnosData: reserva.turnosData,
            // Se guardan los extras resueltos para poder armar el WhatsApp de
            // confirmación sin volver a consultarlos.
            extrasPorServicio: reserva.items.map(i => ({
              servicio_id: i.servicio.id,
              extras: i.extras
            }))
          },
          es_multi: reserva.esMulti,
          monto: cotizacion.monto,
          tipo_pago: cotizacion.tipo,
          estado: 'activa',
          expira_at: expiraAt
        }
      });
    });

    // 4. Preferencia en Mercado Pago. Si falla, el hold se borra: nunca dejar un
    //    horario congelado por un error nuestro.
    const titulo = reserva.items.length === 1
      ? reserva.items[0].servicio.nombre
      : `${reserva.items.length} servicios · Daniela Yanet Beauty`;

    const fechaLegible = new Date(fecha + 'T12:00:00-03:00').toLocaleDateString('es-AR', {
      day: '2-digit', month: '2-digit', year: 'numeric'
    });

    let preferencia;
    try {
      preferencia = await crearPreferencia({
        externalRef,
        titulo: cotizacion.tipo === 'sena' ? `Seña · ${titulo}` : titulo,
        descripcion: `${titulo} · turno del ${fechaLegible} a las ${hora_inicio} hs`,
        monto: cotizacion.monto,
        expiraAt,
        cliente: {
          nombre: reserva.turnosData[0].cliente_nombre,
          apellido: reserva.turnosData[0].cliente_apellido,
          telefono: reserva.turnosData[0].cliente_telefono
        }
      });
    } catch (errMp) {
      await prisma.reservaPendiente.delete({ where: { id: holdCreado.id } }).catch(() => {});
      holdCreado = null;
      console.error('❌ Error creando preferencia en MP:', errMp.response?.data || errMp.message);
      return res.status(503).json({
        error: 'No pudimos abrir el pago. Probá de nuevo en un rato, o escribinos por WhatsApp.'
      });
    }

    await prisma.reservaPendiente.update({
      where: { id: holdCreado.id },
      data: { mp_preference_id: String(preferencia.id) }
    });

    res.status(201).json({
      requiere_pago: true,
      external_ref: externalRef,
      init_point: preferencia.init_point,
      monto: cotizacion.monto,
      tipo: cotizacion.tipo,
      saldo_local: cotizacion.saldo_local,
      expira_at: expiraAt.toISOString(),
      hold_minutos: config.hold_minutos
    });
  } catch (err) {
    if (holdCreado) {
      await prisma.reservaPendiente.delete({ where: { id: holdCreado.id } }).catch(() => {});
    }
    if (err.message === 'HORARIO_NO_DISPONIBLE') {
      return res.status(409).json({ error: 'Ese horario ya no está disponible. Por favor elegí otro.' });
    }
    if (responderErrorReserva(res, err)) return;
    next(err);
  }
});

// ── POST /api/pagos/webhook → notificación de Mercado Pago ──
//
// Público y sin auth: la autenticidad se prueba con la firma, no con un token.
//
// Se responde 200 lo antes posible aunque algo falle internamente: si tardamos o
// devolvemos error, MP reintenta y se acumulan notificaciones. El único 401 es
// por firma inválida.
router.post('/webhook', async (req, res) => {
  // data.id puede venir por query (?data.id=) o en el body, según el tópico.
  const dataId = req.query['data.id'] || req.body?.data?.id;
  const tipo = req.query.type || req.query.topic || req.body?.type;

  if (!validarFirmaWebhook(req.headers['x-signature'], req.headers['x-request-id'], dataId)) {
    console.error('❌ Webhook con firma inválida; se rechaza');
    return res.status(401).json({ error: 'Firma inválida' });
  }

  // Solo interesan los pagos.
  if (tipo !== 'payment') {
    return res.status(200).json({ ok: true, ignorado: tipo });
  }

  try {
    await procesarNotificacionPago(dataId);
  } catch (err) {
    // Se loguea y se devuelve 200 igual: si el problema es nuestro, que no se
    // convierta en una tormenta de reintentos. El cron de reconciliación
    // levanta los pagos que se hayan quedado sin procesar.
    console.error(`❌ Error procesando webhook del pago ${dataId}:`, err.message);
  }

  res.status(200).json({ ok: true });
});

// ── GET /api/pagos/estado/:external_ref → para el polling del frontend ──
// Devuelve lo mínimo para pintar la pantalla de resultado. Nada sensible.
router.get('/estado/:external_ref', async (req, res, next) => {
  try {
    const reserva = await prisma.reservaPendiente.findUnique({
      where: { external_ref: req.params.external_ref }
    });

    if (!reserva) {
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }

    // Un hold vencido que nadie limpió todavía se reporta como expirado.
    let estado = reserva.estado;
    if (estado === 'activa' && reserva.expira_at < new Date()) {
      estado = 'expirada';
    }

    const respuesta = {
      estado,
      fecha: reserva.fecha,
      hora_inicio: reserva.hora_inicio,
      hora_fin: reserva.hora_fin,
      monto: Number(reserva.monto),
      tipo_pago: reserva.tipo_pago,
      expira_at: reserva.expira_at
    };

    if (estado === 'completada') {
      const turnos = await prisma.turno.findMany({
        where: {
          cliente_telefono: reserva.cliente_telefono,
          fecha: reserva.fecha,
          estado: 'confirmado',
          mp_payment_id: { not: null }
        },
        include: { servicio: { select: { nombre: true } } },
        orderBy: { hora_inicio: 'asc' }
      });
      respuesta.turnos = turnos.map(t => ({
        id: t.id,
        servicio: t.servicio?.nombre,
        hora_inicio: t.hora_inicio,
        hora_fin: t.hora_fin,
        pago_monto: t.pago_monto ? Number(t.pago_monto) : null,
        pago_tipo: t.pago_tipo
      }));
    }

    res.json(respuesta);
  } catch (err) { next(err); }
});

module.exports = router;
