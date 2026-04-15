const cron = require('node-cron');
const prisma = require('./prisma');
const { enviarRecordatorio } = require('../services/whatsapp');

function iniciarScheduler() {
  // Corre cada hora en punto (minuto 0)
  cron.schedule('0 * * * *', async () => {
    console.log('🔔 Verificando recordatorios pendientes...');
    try {
      await enviarRecordatoriosPendientes();
    } catch (error) {
      console.error('❌ Error en scheduler de recordatorios:', error.message);
    }
  });

  console.log('📅 Scheduler de recordatorios iniciado (cada hora)');
}

async function enviarRecordatoriosPendientes() {
  // Ventana: turnos entre 20 y 28 horas en el futuro
  // Da margen para que el cron (cada hora) no se pierda ninguno
  const ahora = new Date();
  const desde = new Date(ahora.getTime() + 20 * 60 * 60 * 1000); // +20h
  const hasta = new Date(ahora.getTime() + 28 * 60 * 60 * 1000); // +28h

  const fechaDesde = desde.toISOString().split('T')[0];
  const fechaHasta = hasta.toISOString().split('T')[0];

  // Buscar turnos confirmados sin recordatorio enviado
  const turnos = await prisma.turno.findMany({
    where: {
      estado: 'confirmado',
      recordatorio_enviado: false,
      fecha: {
        gte: new Date(fechaDesde),
        lte: new Date(fechaHasta)
      }
    },
    include: { servicio: true }
  });

  if (turnos.length === 0) {
    console.log('   No hay recordatorios pendientes');
    return;
  }

  console.log(`   Enviando ${turnos.length} recordatorio(s)...`);

  for (const turno of turnos) {
    // Verificar que el turno esté dentro de la ventana de 20-28h
    const fechaTurno = new Date(
      `${turno.fecha.toISOString().split('T')[0]}T${turno.hora_inicio}:00`
    );
    const horasHastaTurno = (fechaTurno - ahora) / (1000 * 60 * 60);

    if (horasHastaTurno >= 20 && horasHastaTurno <= 28) {
      const enviado = await enviarRecordatorio(turno);
      if (enviado) {
        await prisma.turno.update({
          where: { id: turno.id },
          data: { recordatorio_enviado: true }
        });
        console.log(`   ✅ Recordatorio enviado a ${turno.cliente_nombre} (turno #${turno.id})`);
      }
    }
  }
}

module.exports = { iniciarScheduler, enviarRecordatoriosPendientes };
