const cron = require('node-cron');
const prisma = require('../lib/prisma');
const { enviarRecordatorio } = require('./whatsapp');

function iniciarScheduler() {
  // Cada día a las 8:00 AM (hora Argentina UTC-3 = 11:00 UTC)
  cron.schedule('0 11 * * *', async () => {
    console.log('⏰ Ejecutando recordatorios automáticos...');

    try {
      const manana = new Date();
      manana.setDate(manana.getDate() + 1);
      const fechaManana = manana.toISOString().split('T')[0];

      const turnos = await prisma.turno.findMany({
        where: {
          fecha: new Date(fechaManana),
          estado: 'confirmado'
        },
        include: { servicio: true }
      });

      let enviados = 0;
      for (const turno of turnos) {
        const ok = await enviarRecordatorio(turno);
        if (ok) enviados++;
      }

      console.log(`✅ Recordatorios enviados: ${enviados}/${turnos.length}`);
    } catch (error) {
      console.error('❌ Error en scheduler de recordatorios:', error.message);
    }
  });

  console.log('📅 Scheduler de recordatorios iniciado (8:00 AM ARG)');
}

module.exports = { iniciarScheduler };
