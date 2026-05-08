const twilio = require('twilio');

let client = null;
function getClient() {
  if (!client && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return client;
}

// ── Template SIDs aprobados por Meta ──────────
const TEMPLATES = {
  confirmacion:  'HX70dd5436824096aa59bab093172d5cec',
  recordatorio:  'HX2457240295fa7680fd630398d3d1434b',
  cancelacion:   'HX376c93f177b89288c26bb76aa62e474e',
};

// ── Formatear fecha legible ────────────────────
function formatearFecha(fecha) {
  const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const d = new Date(fecha);
  const dia = dias[d.getDay()];
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dia} ${dd}/${mm}`;
}

// ── Enviar con template aprobado ───────────────
async function enviarTemplate(telefono, contentSid, variables) {
  const twClient = getClient();
  if (!twClient) {
    console.log('⚠️  Twilio no configurado. Template no enviado.');
    return false;
  }
  try {
    await twClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:+549${telefono}`,
      contentSid,
      contentVariables: JSON.stringify(variables),
    });
    console.log(`✅ WhatsApp (template) enviado a ${telefono}`);
    return true;
  } catch (error) {
    console.error('❌ Error enviando WhatsApp template:', error.message);
    return false;
  }
}

// ── Enviar mensaje de texto libre (solo para ventana 24hs activa) ──
async function enviarWhatsApp(telefono, mensaje) {
  const twClient = getClient();
  if (!twClient) {
    console.log('⚠️  Twilio no configurado. Mensaje no enviado:', mensaje);
    return false;
  }
  try {
    await twClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:+549${telefono}`,
      body: mensaje,
    });
    console.log(`✅ WhatsApp enviado a ${telefono}`);
    return true;
  } catch (error) {
    console.error('❌ Error enviando WhatsApp:', error.message);
    return false;
  }
}

// ── Confirmación de turno ──────────────────────
// Template: "Hola {{1}}, tu turno está confirmado 🎉 📅 {{2}} ⏰ {{3}} 💅 {{4}} Podés ver tu turno en: {{5}} ¡Te esperamos!"
async function enviarConfirmacion(turno) {
  const fechaStr = formatearFecha(turno.fecha);
  return enviarTemplate(turno.cliente_telefono, TEMPLATES.confirmacion, {
    1: turno.cliente_nombre,
    2: fechaStr,
    3: turno.hora_inicio,
    4: turno.servicio.nombre,
    5: `${process.env.FRONTEND_URL}/mis-turnos`,
  });
}

// ── Recordatorio (24h antes) ───────────────────
// Template: "⏰ ¡Recordatorio de turno! Hola {{1}}, tenés turno mañana: 📅 {{2}} ⏰ {{3}} hs 💅 {{4}} ¿Vas a poder venir?"
// Botones: "Sí, confirmo" / "No puedo ir"
async function enviarRecordatorio(turno) {
  const fechaStr = formatearFecha(turno.fecha);
  return enviarTemplate(turno.cliente_telefono, TEMPLATES.recordatorio, {
    1: turno.cliente_nombre,
    2: fechaStr,
    3: turno.hora_inicio,
    4: turno.servicio.nombre,
  });
}

// ── Confirmación de asistencia (texto libre, dentro de ventana 24hs) ──
async function enviarAsistenciaConfirmada(turno) {
  const mensaje = `✅ ¡Perfecto ${turno.cliente_nombre}!\n\n` +
    `Tu asistencia está confirmada para mañana ` +
    `a las ${turno.hora_inicio} hs.\n\n` +
    `¡Te esperamos! 💅`;
  return enviarWhatsApp(turno.cliente_telefono, mensaje);
}

// ── Cancelación por cliente ────────────────────
// Template: "Hola {{1}}, tu turno fue cancelado. 📅 {{2}} ⏰ {{3}} hs 💅 {{4}} Podés reservar uno nuevo cuando quieras en: {{5}} ¡Te esperamos pronto!"
async function enviarCancelacion(turno) {
  const fechaStr = formatearFecha(turno.fecha);
  return enviarTemplate(turno.cliente_telefono, TEMPLATES.cancelacion, {
    1: turno.cliente_nombre,
    2: fechaStr,
    3: turno.hora_inicio,
    4: turno.servicio.nombre,
    5: process.env.FRONTEND_URL,
  });
}

// ── Notificación a Daniela de cancelación ──────
async function notificarCancelacionADaniela(turno) {
  const fechaStr = formatearFecha(turno.fecha);
  const telefonoDaniela = process.env.DANIELA_TELEFONO;
  if (!telefonoDaniela) {
    console.log('⚠️  DANIELA_TELEFONO no configurado');
    return false;
  }
  const mensaje = `⚠️ Cancelación de turno\n\n` +
    `${turno.cliente_nombre} ${turno.cliente_apellido} canceló su turno:\n` +
    `📅 ${fechaStr}\n` +
    `⏰ ${turno.hora_inicio} hs\n` +
    `💅 ${turno.servicio.nombre}\n` +
    `📱 ${turno.cliente_telefono}\n\n` +
    `El horario quedó libre.`;
  return enviarWhatsApp(telefonoDaniela, mensaje);
}

// ── Modificación ───────────────────────────────
async function enviarModificacion(turno) {
  const fechaStr = formatearFecha(turno.fecha);
  const mensaje = `Hola ${turno.cliente_nombre},\n\n` +
    `Tu turno fue modificado:\n` +
    `📅 ${fechaStr}\n` +
    `⏰ ${turno.hora_inicio} hs\n` +
    `💅 ${turno.servicio.nombre}\n\n` +
    `¡Te esperamos! 💅`;
  return enviarWhatsApp(turno.cliente_telefono, mensaje);
}

// ── Notificación waitlist: se liberó un turno ──
async function notificarWaitlist(entrada, horaLiberada) {
  const fechaStr = formatearFecha(entrada.fecha);
  const mensaje = `¡Hola ${entrada.cliente_nombre}! 👋\n\n` +
    `Se liberó un turno que te puede interesar:\n` +
    `📅 ${fechaStr}\n` +
    `⏰ ${horaLiberada} hs\n` +
    `💅 ${entrada.servicio.nombre}\n\n` +
    `¡Reservalo antes que otro! 👇\n` +
    `${process.env.FRONTEND_URL}/reservar`;
  return enviarWhatsApp(entrada.cliente_telefono, mensaje);
}

// ── Notificación a Daniela: turno tomado por waitlist ──
async function notificarTurnoTomadoWaitlist(turno) {
  const fechaStr = formatearFecha(turno.fecha);
  const telefonoDaniela = process.env.DANIELA_TELEFONO;
  if (!telefonoDaniela) return false;
  const mensaje = `📢 Turno tomado por waitlist\n\n` +
    `${turno.cliente_nombre} ${turno.cliente_apellido} reservó ` +
    `un turno que se había liberado:\n` +
    `📅 ${fechaStr}\n` +
    `⏰ ${turno.hora_inicio} hs\n` +
    `💅 ${turno.servicio.nombre}\n` +
    `📱 ${turno.cliente_telefono}\n\n` +
    `⚠️ No te vayas del local.`;
  return enviarWhatsApp(telefonoDaniela, mensaje);
}

module.exports = {
  enviarConfirmacion,
  enviarRecordatorio,
  enviarAsistenciaConfirmada,
  enviarCancelacion,
  notificarCancelacionADaniela,
  enviarModificacion,
  notificarWaitlist,
  notificarTurnoTomadoWaitlist,
};