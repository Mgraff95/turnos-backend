const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding base de datos...');

  // ── 1. Servicios ─────────────────────────────
  const servicios = [
    { nombre: 'Manicura clásica', duracion_minutos: 30, precio_pesos: 500 },
    { nombre: 'Pedicura deluxe', duracion_minutos: 45, precio_pesos: 700 },
    { nombre: 'Uñas acrílicas', duracion_minutos: 60, precio_pesos: 1000 },
    { nombre: 'Uñas semipermanentes', duracion_minutos: 45, precio_pesos: 800 },
    { nombre: 'Mani + Pedi combo', duracion_minutos: 75, precio_pesos: 1100 },
  ];

  for (const s of servicios) {
    await prisma.servicio.upsert({
      where: { id: servicios.indexOf(s) + 1 },
      create: s,
      update: s
    });
  }
  console.log(`   ✅ ${servicios.length} servicios creados`);

  // ── 2. Horarios config (lun-sáb abierto, dom cerrado) ──
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
    await prisma.horarioConfig.upsert({
      where: { dia_semana: h.dia_semana },
      create: h,
      update: h
    });
  }
  console.log('   ✅ 7 horarios configurados (lun-sáb abierto, dom cerrado)');

  // ── 3. Usuario admin ─────────────────────────
  const adminEmail = process.env.ADMIN_EMAIL || 'daniela@estudio.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const hash = await bcrypt.hash(adminPassword, 10);

  await prisma.usuarioAdmin.upsert({
    where: { email: adminEmail },
    create: {
      email: adminEmail,
      password_hash: hash,
      nombre: 'Daniela',
      activo: true
    },
    update: {
      password_hash: hash,
      nombre: 'Daniela'
    }
  });
  console.log(`   ✅ Admin creado: ${adminEmail}`);

  console.log('\n🎉 Seed completo!');
}

main()
  .catch((e) => {
    console.error('❌ Error en seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
