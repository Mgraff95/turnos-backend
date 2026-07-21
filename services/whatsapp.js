const axios = require('axios');

const WASSENGER_API = 'https://api.wassenger.com/v1';
const WASSENGER_TOKEN = process.env.WASSENGER_TOKEN;
const WASSENGER_DEVICE = process.env.WASSENGER_DEVICE; // ID del número: 6a0e57773741732d95dbd1a3

// ── Formatear fecha legible ────────────────────────────
function formatearFecha(fecha) {
  const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const d = new Date(fecha);
  const dia = dias[d.getDay()];
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dia} ${dd}/${mm}`;
}

// ── Enviar mensaje genérico via Wassenger ──────────────
async function enviarWhatsApp(telefono, mensaje) {
  if (!WASSENGER_TOKEN) {
    console.log('⚠️  Wassenger no configurado. Mensaje no enviado:', mensaje);
    return false;
  }
  try {
    await axios.post(
      `${WASSENGER_API}/messages`,
      {
        phone: `+549${telefono}`,
        message: mensaje,
        ...(WASSENGER_DEVICE ? { device: WASSENGER_DEVICE } : {})
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Token': WASSENGER_TOKEN
        }
      }
    );
    console.log(`✅ WhatsApp (Wassenger) enviado a ${telefono}`);
    return true;
  } catch (error) {
    const errMsg = error.response?.data?.message || error.message;
    console.error(`❌ Error enviando WhatsApp (Wassenger): ${errMsg}`);
    return false;
  }
}

// ── Confirmación de turno ──────────────────────────────
async function enviarConfirmacion(turno) {
  const fechaStr = formatearFecha(turno.fecha);
  let mensaje =
    `¡Hola ${turno.cliente_nombre}! 🎉\n\n` +
    `Tu turno está confirmado:\n` +
    `📅 ${fechaStr}\n` +
    `⏰ ${turno.hora_inicio} hs\n` +
    `💅 ${turno.servicio.nombre}\n`;

  // Si el turno tiene extras, los listamos y mostramos el total
  if (turno.extras && turno.extras.length > 0) {
    mensaje += `\n✨ Extras:\n`;
    let hayVariable = false;
    for (const ex of turno.extras) {
      if (ex.precio_variable) {
        hayVariable = true;
        mensaje += `   • ${ex.nombre} (desde $${Number(ex.precio_pesos)})\n`;
      } else {
        mensaje += `   • ${ex.nombre} (+$${Number(ex.precio_pesos)})\n`;
      }
    }
    const totalExtras = turno.extras.reduce((s, e) => s + Number(e.precio_pesos), 0);
    const total = Number(turno.servicio.precio_pesos) + totalExtras;
    mensaje += hayVariable ? `💰 Total (desde): $${total}\n` : `💰 Total: $${total}\n`;
    if (hayVariable) {
      mensaje += `💡 Los precios "desde" son de referencia y pueden variar según la complejidad del diseño.\n`;
    }
  }

  if (turno.servicio.incluye_nota && turno.servicio.nota) {
    mensaje += `\n📝 ${turno.servicio.nota}\n`;
  }

  mensaje +=
    `\nPodés ver o modificar tu turno en:\n` +
    `${process.env.FRONTEND_URL}/mistura`;
  return enviarWhatsApp(turno.cliente_telefono, mensaje);
}

// ── Confirmación de RESERVA MÚLTIPLE (bloque de varios servicios) ──
// `turnos`: array de turnos del grupo, ordenados por orden_en_grupo.
// Cada turno trae .servicio y opcionalmente .extras (array de extras elegidos).
async function enviarConfirmacionGrupo(turnos) {
  if (!turnos || turnos.length === 0) return false;
  const primero = turnos[0];
  const ultimo = turnos[turnos.length - 1];
  const fechaStr = formatearFecha(primero.fecha);

  let total = 0;
  let hayVariable = false;
  let cuerpo = '';
  for (const t of turnos) {
    cuerpo += `\n⏰ ${t.hora_inicio} hs · 💅 ${t.servicio.nombre}`;
    total += Number(t.servicio.precio_pesos);
    if (t.extras && t.extras.length > 0) {
      for (const ex of t.extras) {
        if (ex.precio_variable) {
          hayVariable = true;
          cuerpo += `\n   ✨ ${ex.nombre} (desde $${Number(ex.precio_pesos)})`;
        } else {
          cuerpo += `\n   ✨ ${ex.nombre} (+$${Number(ex.precio_pesos)})`;
        }
        total += Number(ex.precio_pesos);
      }
    }
  }

  let notas = '';
  for (const t of turnos) {
    if (t.servicio.incluye_nota && t.servicio.nota) {
      notas += `\n📝 ${t.servicio.nombre}: ${t.servicio.nota}`;
    }
  }

  const mensaje =
    `¡Hola ${primero.cliente_nombre}! 🎉\n\n` +
    `Tus turnos están confirmados:\n` +
    `📅 ${fechaStr}\n` +
    `🕐 De ${primero.hora_inicio} a ${ultimo.hora_fin} hs\n` +
    cuerpo + `\n\n` +
    (hayVariable ? `💰 Total (desde): $${total}\n💡 Los precios "desde" son de referencia y pueden variar según la complejidad del diseño.\n\n` : `💰 Total: $${total}\n\n`) +
    (notas ? `${notas}\n\n` : '') +
    `Podés ver o cancelar tus turnos en:\n` +
    `${process.env.FRONTEND_URL}/mistura`;

  return enviarWhatsApp(primero.cliente_telefono, mensaje);
}

// ── Recordatorio con opciones (24h antes) ─────────────
async function enviarRecordatorio(turno) {
  const mensaje =
    `⏰ ¡Recordatorio!\n\n` +
    `Tenés turno mañana a las ${turno.hora_inicio} hs ` +
    `para ${turno.servicio.nombre}.\n\n` +
    `Respondé con:\n` +
    `*1* ✅ Confirmo asistencia\n` +
    `*2* ❌ No puedo ir\n\n` +
    `¡Gracias! 💅`;
  return enviarWhatsApp(turno.cliente_telefono, mensaje);
}

// ── Confirmación de asistencia ─────────────────────────
async function enviarAsistenciaConfirmada(turno) {
  const mensaje =
    `¡Perfecto ${turno.cliente_nombre}! ✅\n\n` +
    `Tu asistencia está confirmada para mañana a las ${turno.hora_inicio} hs.\n\n` +
    `¡Te esperamos en Patricios 1579, Ingeniero Maschwitz! 💅\n` +
    `📍 https://maps.app.goo.gl/j6pj7FT76p2fyp6o8`;
  return enviarWhatsApp(turno.cliente_telefono, mensaje);
}

// ── Cancelación por cliente ────────────────────────────
async function enviarCancelacion(turno) {
  const fechaStr = formatearFecha(turno.fecha);
  const mensaje =
    `Hola ${turno.cliente_nombre},\n\n` +
    `Tu turno del ${fechaStr} a las ${turno.hora_inicio} hs ` +
    `fue cancelado.\n\n` +
    `Podés reservar uno nuevo cuando quieras en:\n` +
    `${process.env.FRONTEND_URL}\n\n` +
    `¡Te esperamos pronto! 💅`;
  return enviarWhatsApp(turno.cliente_telefono, mensaje);
}

// ── Cancelación de RESERVA MÚLTIPLE (bloque completo) ──
async function enviarCancelacionGrupo(turnos) {
  if (!turnos || turnos.length === 0) return false;
  const primero = turnos[0];
  const fechaStr = formatearFecha(primero.fecha);
  const lista = turnos.map(t => `   • ${t.servicio.nombre} (${t.hora_inicio} hs)`).join('\n');
  const mensaje =
    `Hola ${primero.cliente_nombre},\n\n` +
    `Tus turnos del ${fechaStr} fueron cancelados:\n` +
    `${lista}\n\n` +
    `Podés reservar de nuevo cuando quieras en:\n` +
    `${process.env.FRONTEND_URL}\n\n` +
    `¡Te esperamos pronto! 💅`;
  return enviarWhatsApp(primero.cliente_telefono, mensaje);
}

// ── Notificación a Daniela de cancelación ─────────────
async function notificarCancelacionADaniela(turno) {
  const fechaStr = formatearFecha(turno.fecha);
  const telefonoDaniela = process.env.DANIELA_TELEFONO;
  if (!telefonoDaniela) {
    console.log('⚠️  DANIELA_TELEFONO no configurado');
    return false;
  }
  const mensaje =
    `⚠️ Cancelación de turno\n\n` +
    `${turno.cliente_nombre} ${turno.cliente_apellido} canceló su turno:\n` +
    `📅 ${fechaStr}\n` +
    `⏰ ${turno.hora_inicio} hs\n` +
    `💅 ${turno.servicio.nombre}\n` +
    `📱 ${turno.cliente_telefono}\n\n` +
    `El horario quedó libre.`;
  return enviarWhatsApp(telefonoDaniela, mensaje);
}

// ── Notificación a Daniela de cancelación de bloque ────
async function notificarCancelacionGrupoADaniela(turnos) {
  if (!turnos || turnos.length === 0) return false;
  const telefonoDaniela = process.env.DANIELA_TELEFONO;
  if (!telefonoDaniela) {
    console.log('⚠️  DANIELA_TELEFONO no configurado');
    return false;
  }
  const primero = turnos[0];
  const ultimo = turnos[turnos.length - 1];
  const fechaStr = formatearFecha(primero.fecha);
  const lista = turnos.map(t => `   • ${t.servicio.nombre} (${t.hora_inicio} hs)`).join('\n');
  const mensaje =
    `⚠️ Cancelación de turnos\n\n` +
    `${primero.cliente_nombre} ${primero.cliente_apellido} canceló su reserva:\n` +
    `📅 ${fechaStr}\n` +
    `🕐 De ${primero.hora_inicio} a ${ultimo.hora_fin} hs\n` +
    `${lista}\n` +
    `📱 ${primero.cliente_telefono}\n\n` +
    `El bloque quedó libre.`;
  return enviarWhatsApp(telefonoDaniela, mensaje);
}

// ── Modificación ───────────────────────────────────────
async function enviarModificacion(turno) {
  const fechaStr = formatearFecha(turno.fecha);
  const mensaje =
    `Hola ${turno.cliente_nombre},\n\n` +
    `Tu turno fue modificado:\n` +
    `📅 ${fechaStr}\n` +
    `⏰ ${turno.hora_inicio} hs\n` +
    `💅 ${turno.servicio.nombre}\n\n` +
    `¡Te esperamos! 💅`;
  return enviarWhatsApp(turno.cliente_telefono, mensaje);
}

// ── Notificación waitlist: se liberó un turno ─────────
async function notificarWaitlist(entrada, horaLiberada) {
  const fechaStr = formatearFecha(entrada.fecha);
  const mensaje =
    `¡Hola ${entrada.cliente_nombre}! 👋\n\n` +
    `Se liberó un turno que te puede interesar:\n` +
    `📅 ${fechaStr}\n` +
    `⏰ ${horaLiberada} hs\n` +
    `💅 ${entrada.servicio.nombre}\n\n` +
    `¡Reservalo antes que otro! 👇\n` +
    `${process.env.FRONTEND_URL}`;
  return enviarWhatsApp(entrada.cliente_telefono, mensaje);
}

// ── Notificación a Daniela: turno tomado por waitlist ──
async function notificarTurnoTomadoWaitlist(turno) {
  const fechaStr = formatearFecha(turno.fecha);
  const telefonoDaniela = process.env.DANIELA_TELEFONO;
  if (!telefonoDaniela) return false;
  const mensaje =
    `📢 Turno tomado por waitlist\n\n` +
    `${turno.cliente_nombre} ${turno.cliente_apellido} reservó ` +
    `un turno que se había liberado:\n` +
    `📅 ${fechaStr}\n` +
    `⏰ ${turno.hora_inicio} hs\n` +
    `💅 ${turno.servicio.nombre}\n` +
    `📱 ${turno.cliente_telefono}\n\n` +
    `⚠️ No te vayas del local.`;
  return enviarWhatsApp(telefonoDaniela, mensaje);
}

// ── Mensaje genérico (para respuestas del webhook) ─────
async function enviarMensaje(telefono, texto) {
  return enviarWhatsApp(telefono, texto);
}

module.exports = {
  enviarConfirmacion,
  enviarConfirmacionGrupo,
  enviarRecordatorio,
  enviarAsistenciaConfirmada,
  enviarCancelacion,
  enviarCancelacionGrupo,
  notificarCancelacionADaniela,
  notificarCancelacionGrupoADaniela,
  enviarModificacion,
  notificarWaitlist,
  notificarTurnoTomadoWaitlist,
  enviarMensaje
};
