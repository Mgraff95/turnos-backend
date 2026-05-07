const twilio = require('twilio');

let client = null;
function getClient() {
  if (!client && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return client;
}

function formatearFecha(fecha) {
  const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const d = new Date(fecha);
  const dia = dias[d.getDay()];
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dia} ${dd}/${mm}`;
}

async function enviarTemplate(telefono, contentSid, variables) {
  const twClient = getClient();
  if (!twClient) {
    console.log('⚠️  Twilio no configurado. Mensaje no enviado.');
    return false;
  }
  try {
    await twClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:+549${telefono}`,
      contentSid,
      contentVariables: JSON.stringify(variables)
    });
    console.log(`✅ WhatsApp enviado a ${telefono}`);
    return true;
  } catch (error) {
    console.error('❌ Error enviando WhatsApp:', error.message);
    return false;
  }
}

async function enviarConfirmacion(turno) {
  return enviarTemplate(turno.cliente_telefono, 'HX70dd5436824096aa59bab093172d5cec', {
    1: turno.cliente_nombre,
    2: formatearFecha(turno.fecha),
    3: turno.hora_inicio,
    4: turno.servicio.nombre,
    5: `${process.env.FRONTEND_URL}/mistura`
  });
}

async function enviarRecordatorio(turno) {
  return enviarTemplate(turno.cliente_telefono, 'HX2457240295fa7680fd630398d3d1434b', {
    1: turno.cliente_nombre,
    2: formatearFecha(turno.fecha),
    3: turno.hora_inicio,
    4: turno.servicio.nombre
  });
}

async function enviarCancelacion(turno) {
  return enviarTemplate(turno.cliente_telefono, 'HX376c93f177b89288c26bb76aa62e474e', {
    1: turno.cliente_nombre,
    2: formatearFecha(turno.fecha),
    3: turno.hora_inicio,
    4: turno.servicio.nombre,
    5: process.env.FRONTEND_URL
  });
}

async function enviarAsistenciaConfirmada(turno) {
  // Mensaje simple sin template — solo se envía si el cliente escribió primero (sesión abierta)
  const twClient = getClient();
  if (!twClient) return false;
  try {
    await twClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:+549${turno.cliente_telefono}`,
      body: `✅ ¡Perfecto ${turno.cliente_nombre}! Tu asistencia está confirmada para mañana a las ${turno.hora_inicio} hs. ¡Te esperamos! 💅`
    });
    return true;
  } catch (error) {
    console.error('❌ Error enviando WA asistencia confirmada:', error.message);
    return false;
  }
}

async function notificarCancelacionADaniela(turno) {
  const telefonoDaniela = process.env.DANIELA_TELEFONO;
  if (!telefonoDaniela) {
    console.log('⚠️  DANIELA_TELEFONO no configurado');
    return false;
  }
  const fechaStr = formatearFecha(turno.fecha);
  const twClient = getClient();
  if (!twClient) return false;
  try {
    await twClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:+549${telefonoDaniela}`,
      body: `⚠️ Cancelación de turno\n\n${turno.cliente_nombre} ${turno.cliente_apellido} canceló:\n📅 ${fechaStr}\n⏰ ${turno.hora_inicio} hs\n💅 ${turno.servicio.nombre}\n📱 ${turno.cliente_telefono}\n\nEl horario quedó libre.`
    });
    return true;
  } catch (error) {
    console.error('❌ Error notificando a Daniela:', error.message);
    return false;
  }
}

async function enviarModificacion(turno) {
  const fechaStr = formatearFecha(turno.fecha);
  const twClient = getClient();
  if (!twClient) return false;
  try {
    await twClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:+549${turno.cliente_telefono}`,
      body: `Hola ${turno.cliente_nombre}, tu turno fue modificado:\n📅 ${fechaStr}\n⏰ ${turno.hora_inicio} hs\n💅 ${turno.servicio.nombre}\n\n¡Te esperamos! 💅`
    });
    return true;
  } catch (error) {
    console.error('❌ Error enviando WA modificación:', error.message);
    return false;
  }
}

async function notificarWaitlist(entrada, horaLiberada) {
  const fechaStr = formatearFecha(entrada.fecha);
  const twClient = getClient();
  if (!twClient) return false;
  try {
    await twClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:+549${entrada.cliente_telefono}`,
      body: `¡Hola ${entrada.cliente_nombre}! 👋\n\nSe liberó un turno:\n📅 ${fechaStr}\n⏰ ${horaLiberada} hs\n💅 ${entrada.servicio.nombre}\n\n¡Reservalo antes que otro! 👇\n${process.env.FRONTEND_URL}/reservar`
    });
    return true;
  } catch (error) {
    console.error('❌ Error notificando waitlist:', error.message);
    return false;
  }
}

async function notificarTurnoTomadoWaitlist(turno) {
  const telefonoDaniela = process.env.DANIELA_TELEFONO;
  if (!telefonoDaniela) return false;
  const fechaStr = formatearFecha(turno.fecha);
  const twClient = getClient();
  if (!twClient) return false;
  try {
    await twClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:+549${telefonoDaniela}`,
      body: `📢 Turno tomado por waitlist\n\n${turno.cliente_nombre} ${turno.cliente_apellido} reservó un turno liberado:\n📅 ${fechaStr}\n⏰ ${turno.hora_inicio} hs\n💅 ${turno.servicio.nombre}\n📱 ${turno.cliente_telefono}`
    });
    return true;
  } catch (error) {
    console.error('❌ Error notificando turno waitlist a Daniela:', error.message);
    return false;
  }
}

module.exports = {
  enviarConfirmacion,
  enviarRecordatorio,
  enviarAsistenciaConfirmada,
  enviarCancelacion,
  notificarCancelacionADaniela,
  enviarModificacion,
  notificarWaitlist,
  notificarTurnoTomadoWaitlist
};