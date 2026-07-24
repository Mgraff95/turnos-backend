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
  const ahora = new Date();
 
  // No enviar recordatorios entre la medianoche y las 9:00 hs (hora Argentina, UTC-3
  // todo el año, sin horario de verano). La ventana de abajo dura exactamente 24hs
  // (26-2), así que siempre pasa por las 9:00 de algún día — no se pierde ningún
  // turno, simplemente se manda un poco más temprano en vez de a las 4 u 5 AM.
  const horaArgentina = (ahora.getUTCHours() - 3 + 24) % 24;
  if (horaArgentina < 9) {
    console.log(`   ⏳ Son las ${horaArgentina}:00 hs ARG — se espera hasta las 9:00 para enviar recordatorios`);
    return;
  }
 
  // Ventana: turnos entre 2 y 26 horas en el futuro
  // Da margen para que el cron (cada hora) no se pierda ninguno
  const desde = new Date(ahora.getTime() + 2 * 60 * 60 * 1000);  // +2h
  const hasta = new Date(ahora.getTime() + 26 * 60 * 60 * 1000); // +26h
 
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
 
if (horasHastaTurno >= 2 && horasHastaTurno <= 26) {
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
