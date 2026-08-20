// Qué pasa cuando Mercado Pago avisa que un pago fue aprobado.
//
// Este archivo es el punto donde la plata se convierte en turnos. Todo lo que
// pueda salir mal acá termina en uno de dos estados feos: una clienta que pagó y
// no tiene turno, o un turno que nadie pagó. Por eso cada camino está explícito.
const prisma = require('./prisma');
const { verificarYReservar, verificarYReservarBloque } = require('./availability');
const { revivirTurnosData } = require('./reservas');
const { obtenerPago, reembolsarPago } = require('../services/mercadopago');
const {
  enviarConfirmacion,
  enviarConfirmacionGrupo,
  notificarNuevoTurnoADaniela,
  notificarNuevoTurnoGrupoADaniela,
  enviarMensaje
} = require('../services/whatsapp');

// Tolerancia al comparar montos: son pesos con 2 decimales, no centavos sueltos.
const TOLERANCIA_MONTO = 1;

function avisarADaniela(texto) {
  const tel = process.env.DANIELA_TELEFONO;
  if (!tel) {
    console.log('⚠️  DANIELA_TELEFONO no configurado. Aviso no enviado:', texto);
    return Promise.resolve(false);
  }
  return enviarMensaje(tel, texto);
}

// Registra el pago en la tabla de auditoría. Es idempotente por mp_payment_id:
// si el webhook llega repetido, el upsert no duplica nada.
async function registrarPago(payment, { reserva, turnoIds = [], grupoReserva = null, estadoOverride }) {
  return prisma.pago.upsert({
    where: { mp_payment_id: String(payment.id) },
    create: {
      mp_payment_id: String(payment.id),
      mp_preference_id: payment.preference_id ? String(payment.preference_id) : (reserva?.mp_preference_id || null),
      external_ref: payment.external_reference || reserva?.external_ref || null,
      cliente_telefono: reserva?.cliente_telefono || 'desconocido',
      monto: payment.transaction_amount,
      tipo: reserva?.tipo_pago || 'sena',
      estado: estadoOverride || payment.status,
      metodo: payment.payment_method_id || null,
      grupo_reserva: grupoReserva,
      turno_ids: turnoIds,
      raw: payment
    },
    update: {
      estado: estadoOverride || payment.status,
      turno_ids: turnoIds.length > 0 ? turnoIds : undefined,
      grupo_reserva: grupoReserva || undefined,
      raw: payment
    }
  });
}

// Cuando se cobró pero el horario ya no está: no se crea el turno, se devuelve
// la plata y se avisa a las dos partes. Tiene que ser rarísimo, pero si no está
// contemplado quedás con plata cobrada y sin turno.
async function resolverConflicto(reserva, payment, motivo) {
  console.error(`❌ CONFLICTO de pago ${payment.id} (${reserva.external_ref}): ${motivo}`);

  await prisma.reservaPendiente.update({
    where: { id: reserva.id },
    data: { estado: 'conflicto' }
  });

  let reembolso = 'no intentado';
  try {
    await reembolsarPago(payment.id);
    reembolso = 'reembolsado';
  } catch (err) {
    reembolso = 'FALLÓ el reembolso: ' + (err.response?.data?.message || err.message);
    console.error('❌ ' + reembolso);
  }

  await registrarPago(payment, {
    reserva,
    estadoOverride: reembolso === 'reembolsado' ? 'refunded' : payment.status
  });

  const fechaStr = new Date(reserva.fecha).toLocaleDateString('es-AR', {
    weekday: 'long', day: '2-digit', month: '2-digit'
  });

  // A la clienta: disculpa + invitación a reelegir horario.
  enviarMensaje(reserva.cliente_telefono,
    `Hola ${reserva.cliente_nombre} 👋\n\n` +
    `Tuvimos un problema al confirmar tu turno del ${fechaStr} a las ${reserva.hora_inicio} hs: ` +
    `ese horario se ocupó justo mientras se procesaba tu pago.\n\n` +
    `Ya te devolvimos el dinero. Puede tardar unos días en verse acreditado según tu medio de pago.\n\n` +
    `Podés elegir otro horario acá:\n${process.env.FRONTEND_URL}\n\n` +
    `¡Perdón por la molestia! 💅`
  ).catch(err => console.error('Error enviando disculpa:', err.message));

  // A Daniela: que se entere aunque el reembolso haya fallado.
  avisarADaniela(
    `⚠️ Conflicto de pago\n\n` +
    `${reserva.cliente_nombre} ${reserva.cliente_apellido} pagó $${payment.transaction_amount} ` +
    `por el ${fechaStr} a las ${reserva.hora_inicio} hs, pero el horario ya estaba ocupado.\n\n` +
    `Motivo: ${motivo}\n` +
    `Reembolso: ${reembolso}\n` +
    `Pago MP: ${payment.id}\n` +
    `📱 ${reserva.cliente_telefono}`
  ).catch(err => console.error('Error avisando a Daniela:', err.message));

  return { ok: false, estado: 'conflicto', motivo };
}

// ── El corazón: pago aprobado → turnos ─────────────────
async function procesarPagoAprobado(payment) {
  const externalRef = payment.external_reference;

  // 1. Buscar el hold que originó el pago
  const reserva = externalRef
    ? await prisma.reservaPendiente.findUnique({ where: { external_ref: externalRef } })
    : null;

  if (!reserva) {
    console.error(`❌ Pago ${payment.id} sin reserva pendiente (ref: ${externalRef})`);
    await registrarPago(payment, { reserva: null });
    avisarADaniela(
      `⚠️ Pago sin reserva asociada\n\n` +
      `Entró un pago de $${payment.transaction_amount} que no corresponde a ninguna reserva ` +
      `en curso (ref: ${externalRef || 'sin referencia'}).\n\n` +
      `Pago MP: ${payment.id}\n\n` +
      `Hay que revisarlo a mano.`
    ).catch(() => {});
    return { ok: false, estado: 'huerfano' };
  }

  // 2. Idempotencia: si ya se procesó, no hacer nada
  if (reserva.estado === 'completada') {
    console.log(`ℹ️  Reserva ${externalRef} ya estaba completada; webhook repetido ignorado`);
    return { ok: true, estado: 'completada', yaProcesada: true };
  }
  if (reserva.estado === 'conflicto') {
    console.log(`ℹ️  Reserva ${externalRef} ya marcada como conflicto`);
    return { ok: false, estado: 'conflicto', yaProcesada: true };
  }

  // 3. El monto pagado tiene que ser el que se pidió
  const esperado = Number(reserva.monto);
  const pagado = Number(payment.transaction_amount);
  if (Math.abs(pagado - esperado) > TOLERANCIA_MONTO) {
    return resolverConflicto(reserva, payment,
      `el monto pagado ($${pagado}) no coincide con el esperado ($${esperado})`);
  }

  // 4. Crear los turnos, ignorando el propio hold en la validación.
  //    Un hold vencido pero con el slot libre igual se acepta: es mejor
  //    experiencia y no hay razón para rechazar un pago que ya entró.
  const payload = reserva.payload || {};
  const turnosData = revivirTurnosData(payload.turnosData);

  if (turnosData.length === 0) {
    return resolverConflicto(reserva, payment, 'el hold no tenía turnos para crear');
  }

  const datosPago = {
    pago_realizado: true,
    pago_monto: pagado,
    pago_tipo: reserva.tipo_pago,
    mp_payment_id: String(payment.id)
  };

  let turnosCreados;
  try {
    if (turnosData.length === 1) {
      const turno = await verificarYReservar(
        { ...turnosData[0], ...datosPago },
        { ignorarHoldId: reserva.id }
      );
      turnosCreados = [turno];
    } else {
      turnosCreados = await verificarYReservarBloque(
        turnosData.map(t => ({ ...t, ...datosPago })),
        reserva.hora_inicio,
        reserva.hora_fin,
        { ignorarHoldId: reserva.id }
      );
    }
  } catch (err) {
    if (err.message === 'HORARIO_NO_DISPONIBLE') {
      return resolverConflicto(reserva, payment, 'el horario se ocupó mientras se procesaba el pago');
    }
    throw err;
  }

  turnosCreados.sort((a, b) => a.hora_inicio.localeCompare(b.hora_inicio));

  // 5. Registrar el pago y cerrar el hold
  await registrarPago(payment, {
    reserva,
    turnoIds: turnosCreados.map(t => t.id),
    grupoReserva: turnosCreados[0].grupo_reserva || null
  });

  await prisma.reservaPendiente.update({
    where: { id: reserva.id },
    data: { estado: 'completada' }
  });

  // 6. WhatsApp fuera de la transacción y con catch: que un fallo de Wassenger
  //    nunca tumbe un turno ya creado y pagado.
  //    Ojo: Wassenger devuelve 200 aunque el dispositivo esté desconectado, así
  //    que un 200 no garantiza que el mensaje haya llegado.
  const extrasPorServicio = new Map((payload.extrasPorServicio || []).map(e => [e.servicio_id, e.extras]));
  turnosCreados.forEach(t => { t.extras = extrasPorServicio.get(t.servicio_id) || []; });

  if (turnosCreados.length === 1) {
    enviarConfirmacion(turnosCreados[0]).catch(err =>
      console.error('Error enviando WA de confirmación:', err.message));
    notificarNuevoTurnoADaniela(turnosCreados[0]).catch(err =>
      console.error('Error notificando a Daniela:', err.message));
  } else {
    enviarConfirmacionGrupo(turnosCreados).catch(err =>
      console.error('Error enviando WA de grupo:', err.message));
    notificarNuevoTurnoGrupoADaniela(turnosCreados).catch(err =>
      console.error('Error notificando grupo a Daniela:', err.message));
  }

  console.log(`✅ Pago ${payment.id} procesado: ${turnosCreados.length} turno(s) creado(s)`);
  return { ok: true, estado: 'completada', turnos: turnosCreados };
}

// Pago rechazado o cancelado: se libera el slot enseguida en vez de esperar a
// que venza el hold.
async function procesarPagoNoAprobado(payment) {
  const externalRef = payment.external_reference;
  const reserva = externalRef
    ? await prisma.reservaPendiente.findUnique({ where: { external_ref: externalRef } })
    : null;

  if (reserva && reserva.estado === 'activa') {
    await prisma.reservaPendiente.update({
      where: { id: reserva.id },
      data: { estado: 'cancelada' }
    });
    console.log(`ℹ️  Reserva ${externalRef} cancelada (pago ${payment.status})`);
  }

  await registrarPago(payment, { reserva });
  return { ok: false, estado: 'cancelada' };
}

// Punto de entrada del webhook: consulta el pago en MP (única fuente confiable)
// y despacha según el estado real.
async function procesarNotificacionPago(paymentId) {
  const payment = await obtenerPago(paymentId);

  if (payment.status === 'approved') {
    return procesarPagoAprobado(payment);
  }
  if (['rejected', 'cancelled'].includes(payment.status)) {
    return procesarPagoNoAprobado(payment);
  }

  // pending / in_process / authorized: se registra y se espera otra notificación.
  console.log(`ℹ️  Pago ${payment.id} en estado ${payment.status}; sin acción`);
  const reserva = payment.external_reference
    ? await prisma.reservaPendiente.findUnique({ where: { external_ref: payment.external_reference } })
    : null;
  await registrarPago(payment, { reserva });
  return { ok: true, estado: payment.status };
}

module.exports = {
  procesarPagoAprobado,
  procesarPagoNoAprobado,
  procesarNotificacionPago,
  registrarPago
};
