const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Migrando horarios a múltiples rangos...');

  // Verificar si ya hay horarios con el formato nuevo (múltiples por día)
  const existentes = await prisma.horarioConfig.findMany();
  
  if (existentes.length > 0) {
    console.log(`   Ya hay ${existentes.length} rangos configurados. No se modifican.`);
  } else {
    // Crear rangos por defecto (un solo rango por día)
    const horarios = [
      { dia_semana: 0, abierto: true, hora_inicio: '09:00', hora_fin: '18:00', espacio_entre_turnos_min: 10 },
      { dia_semana: 1, abierto: true, hora_inicio: '09:00', hora_fin: '18:00', espacio_entre_turnos_min: 10 },
      { dia_semana: 2, abierto: true, hora_inicio: '10:00', hora_fin: '20:00', espacio_entre_turnos_min: 10 },
      { dia_semana: 3, abierto: true, hora_inicio: '09:00', hora_fin: '18:00', espacio_entre_turnos_min: 10 },
      { dia_semana: 4, abierto: true, hora_inicio: '09:00', hora_fin: '20:00', espacio_entre_turnos_min: 10 },
      { dia_semana: 5, abierto: true, hora_inicio: '09:00', hora_fin: '17:00', espacio_entre_turnos_min: 10 },
      { dia_semana: 6, abierto: false, hora_inicio: '09:00', hora_fin: '18:00', espacio_entre_turnos_min: 10 },
    ];

    for (const h of horarios) {
      await prisma.horarioConfig.create({ data: h });
    }
    console.log('   ✅ 7 rangos por defecto creados');
  }

  console.log('🎉 Migración completa!');
}

main()
  .catch((e) => { console.error('❌ Error:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
