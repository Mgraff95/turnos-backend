const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const {
  enviarAsistenciaConfirmada,
  enviarCancelacion,
  notificarCancelacionADaniela
} = require('../services/whatsapp');

// ── POST /api/whatsapp/webhook ─────────────────
// Twilio envía acá las respuestas del cliente
router.post('/', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { Body, From } = req.body;

    console.log(`📩 Mensaje recibido de ${From}: "${Body}"`);

    // Extraer número limpio (viene como whatsapp:+549XXXXXXXXXX)
    const telefono = From.replace('whatsapp:+549', '').replace('whatsapp:+54', '');
    const respuesta = Body.trim();

    // Buscar el turno más próximo confirmado de este cliente
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
      // Responder con TwiML vacío
      res.type('text/xml');
      return res.send('<Response></Response>');
    }

    if (respuesta === '1') {
      // ── CONFIRMA ASISTENCIA ──
      console.log(`   ✅ ${turno.cliente_nombre} confirmó asistencia (turno #${turno.id})`);
      await enviarAsistenciaConfirmada(turno);

    } else if (respuesta === '2') {
      // ── CANCELA ──
      console.log(`   ❌ ${turno.cliente_nombre} canceló (turno #${turno.id})`);

      // Actualizar estado
      await prisma.turno.update({
        where: { id: turno.id },
        data: { estado: 'cancelado' }
      });

      // Notificar al cliente con link para reprogramar
      await enviarCancelacion(turno);

      // Notificar a Daniela
      await notificarCancelacionADaniela(turno);

    } else {
      console.log(`   ❓ Respuesta no reconocida: "${respuesta}"`);
    }

    // Twilio espera TwiML como respuesta
    res.type('text/xml');
    res.send('<Response></Response>');

  } catch (error) {
    console.error('❌ Error en webhook WhatsApp:', error.message);
    res.type('text/xml');
    res.send('<Response></Response>');
  }
});

module.exports = router;