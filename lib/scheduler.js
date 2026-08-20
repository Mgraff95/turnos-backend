
const cron = require('node-cron');
const prisma = require('./prisma');
const { enviarRecordatorio, enviarResumenDiarioADaniela } = require('../services/whatsapp');
 
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
 
  // Todos los días a las 19:00 hora Argentina (22:00 UTC)
  cron.schedule('0 22 * * *', async () => {
    console.log('📋 Enviando resumen diario a Daniela...');
    try {
      await enviarResumenDiario();
    } catch (error) {
      console.error('❌ Error en scheduler de resumen diario:', error.message);
    }
  });
 
  // Limpieza de holds de pago vencidos. Es solo higiene: las consultas de
  // disponibilidad ya filtran por expira_at, así que el horario se libera
  // solo aunque este cron no llegue a correr.
  cron.schedule('*/5 * * * *', async () => {
    try {
      await limpiarReservasVencidas();
    } catch (error) {
      console.error('❌ Error limpiando reservas pendientes:', error.message);
    }
  });
 
  console.log('📅 Scheduler de recordatorios iniciado (cada hora)');
  console.log('📅 Scheduler de resumen diario iniciado (19:00 ARG)');
  console.log('🧹 Limpieza de reservas pendientes iniciada (cada 5 min)');
}
 
// ── Marcar como expirados los holds de pago vencidos ───
async function limpiarReservasVencidas() {
  const res = await prisma.reservaPendiente.updateMany({
    where: { estado: 'activa', expira_at: { lt: new Date() } },
    data: { estado: 'expirada' }
  });
  if (res.count > 0) {
    console.log(`   🧹 ${res.count} reserva(s) pendiente(s) vencida(s)`);
  }
  return res.count;
}
 
// ── Resumen diario: agenda de mañana para Daniela ──────
async function enviarResumenDiario() {
  const manana = new Date();
  manana.setDate(manana.getDate() + 1);
  const fechaManana = manana.toISOString().split('T')[0];
 
  const turnos = await prisma.turno.findMany({
    where: {
      fecha: new Date(fechaManana),
      estado: 'confirmado'
    },
    include: { servicio: true },
    orderBy: [{ hora_inicio: 'asc' }, { orden_en_grupo: 'asc' }]
  });
 
  // Agrupar por grupo_reserva (los turnos sueltos quedan como grupo de 1)
  const gruposMap = new Map();
  const ordenGrupos = [];
  for (const turno of turnos) {
    const clave = turno.grupo_reserva || `individual-${turno.id}`;
    if (!gruposMap.has(clave)) {
      gruposMap.set(clave, []);
      ordenGrupos.push(clave);
    }
    gruposMap.get(clave).push(turno);
  }
 
  const gruposDelDia = ordenGrupos
    .map(clave => gruposMap.get(clave).sort((a, b) => (a.orden_en_grupo || 0) - (b.orden_en_grupo || 0)))
    .sort((a, b) => a[0].hora_inicio.localeCompare(b[0].hora_inicio));
 
  await enviarResumenDiarioADaniela(new Date(fechaManana), gruposDelDia);
  console.log(`   ✅ Resumen diario enviado (${gruposDelDia.length} bloque(s) para mañana)`);
}
 
async function enviarRecordatoriosPendientes() {
  // Ventana: turnos entre 2 y 26 horas en el futuro
  // Da margen para que el cron (cada hora) no se pierda ninguno
  const ahora = new Date();
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
    // Verificar que el turno esté dentro de la ventana de 2-26h
    // IMPORTANTE: se fuerza el offset -03:00 (Argentina) porque hora_inicio
    // se guarda como hora local ART. Sin esto, en un servidor corriendo en
    // UTC (Railway, por defecto) el turno se interpreta 3hs antes de lo real
    // y el recordatorio termina saliendo de madrugada.
    const fechaTurno = new Date(
      `${turno.fecha.toISOString().split('T')[0]}T${turno.hora_inicio}:00-03:00`
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
 
module.exports = { iniciarScheduler, enviarRecordatoriosPendientes, limpiarReservasVencidas };
 
