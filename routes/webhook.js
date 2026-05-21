const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const {
  enviarAsistenciaConfirmada,
  enviarCancelacion,
  notificarCancelacionADaniela,
  notificarWaitlist
} = require('../services/whatsapp');

// ── Determinar franja horaria ──────────────────
function determinarFranja(horaInicio) {
  const hora = parseInt(horaInicio.split(':')[0]);
  return hora < 14 ? 'manana' : 'tarde';
}

// ── Notificar waitlist cuando se libera un turno ──
async function procesarWaitlist(turno) {
  const franja = determinarFranja(turno.hora_inicio);

  const esperando = await prisma.waitlist.findMany({
    where: {
      fecha: turno.fecha,
      franja,
      activo: true,
      notificado: false
    },
    include: { servicio: true }
  });

  if (esperando.length === 0) {
    console.log('   No hay nadie en waitlist para este horario');
    return;
  }

  console.log(`   Notificando a ${esperando.length} persona(s) en waitlist...`);

  for (const entrada of esperando) {
    const enviado = await notificarWaitlist(entrada, turno.hora_inicio);
    if (enviado) {
      await prisma.waitlist.update({
        where: { id: entrada.id },
        data: { notificado: true }
      });
      console.log(`   ✅ Waitlist notificado: ${entrada.cliente_nombre} (${entrada.cliente_telefono})`);
    }
  }
}

// ── POST /api/whatsapp/webhook (Wassenger) ─────
router.post('/', express.json(), async (req, res) => {
  try {
    // Wassenger envía el payload en formato JSON
    const payload = req.body;

    // Solo procesar mensajes entrantes (no los que envía el sistema)
    if (!payload || payload.event !== 'message:in:new') {
      return res.sendStatus(200);
    }

    const data = payload.data;
    if (!data) return res.sendStatus(200);

    const fromPhone = data.fromNumber || data.from || '';
    const bodyText = data.body || data.text || '';

    console.log(`📩 Mensaje recibido de ${fromPhone}: "${bodyText}"`);

    // Limpiar teléfono — quedarnos solo con los 10 dígitos locales
    const telefono = fromPhone
      .replace(/\D/g, '')
      .replace(/^549/, '')
      .replace(/^54/, '')
      .slice(-10);

    const respuesta = bodyText.trim();

    const hoy = new Date();
    const turno = await prisma.turno.findFirst({
      where: {
        cliente_telefono: telefono,
        estado: 'confirmado',
        recordatorio_enviado: true,
        fecha: { gte: hoy }
      },
      include: { servicio: true },
      orderBy: [{ fecha: 'asc' }, { hora_inicio: 'asc' }]
    });

    if (!turno) {
      console.log(`   No se encontró turno pendiente para ${telefono}`);
      return res.sendStatus(200);
    }

    if (respuesta === '1') {
      console.log(`   ✅ ${turno.cliente_nombre} confirmó asistencia (turno #${turno.id})`);
      await enviarAsistenciaConfirmada(turno);

    } else if (respuesta === '2') {
      console.log(`   ❌ ${turno.cliente_nombre} canceló (turno #${turno.id})`);

      await prisma.turno.update({
        where: { id: turno.id },
        data: { estado: 'cancelado' }
      });

      await enviarCancelacion(turno);
      await notificarCancelacionADaniela(turno);
      await procesarWaitlist(turno);

    } else {
      console.log(`   ❓ Respuesta no reconocida: "${respuesta}"`);
    }

    res.sendStatus(200);

  } catch (error) {
    console.error('❌ Error en webhook Wassenger:', error.message);
    res.sendStatus(200);
  }
});

module.exports = router;
