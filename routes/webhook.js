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

// ── POST /api/whatsapp/webhook ─────────────────
router.post('/', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { Body, From } = req.body;

    console.log(`📩 Mensaje recibido de ${From}: "${Body}"`);

    const telefono = From.replace('whatsapp:+549', '').replace('whatsapp:+54', '');
    const respuesta = Body.trim();

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
      res.type('text/xml');
      return res.send('<Response></Response>');
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

      // Notificar a la waitlist
      await procesarWaitlist(turno);

    } else {
      console.log(`   ❓ Respuesta no reconocida: "${respuesta}"`);
    }

    res.type('text/xml');
    res.send('<Response></Response>');

  } catch (error) {
    console.error('❌ Error en webhook WhatsApp:', error.message);
    res.type('text/xml');
    res.send('<Response></Response>');
  }
});

module.exports = router;