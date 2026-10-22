// Carga las dos profesionales con ids FIJOS.
//
// Los ids importan: el paso siguiente de la migración agrega las FK con
// `@default(1)` para que todo lo que ya existe quede apuntando a Daniela sin
// ningún UPDATE a mano. Si Daniela no es la 1, el backfill queda mal.
//
// Es idempotente a propósito: correrlo dos veces no duplica nada y NO pisa lo
// que se haya cargado después desde el panel (comisión, teléfono, orden). Solo
// garantiza que las dos filas existan.
//
// Correr DENTRO de /app en la Console de Railway, no en /tmp: node_modules está
// en /app y desde /tmp no resuelve require('@prisma/client').
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Cargando profesionales...');

  const profesionales = [
    {
      id: 1,
      nombre: 'Daniela',
      orden: 0,
      telefono: process.env.DANIELA_TELEFONO || null,
      // null = es la dueña del estudio: la plata de sus turnos es del estudio
      // y no hay nada que liquidarle.
      comision_pct_default: null
    },
    {
      id: 2,
      nombre: 'Elsa',
      orden: 1,
      telefono: null,
      // Arranca en null a propósito. Un porcentaje inventado acá se liquidaría
      // con un número que nadie decidió; Daniela lo carga desde el panel.
      comision_pct_default: null
    }
  ];

  for (const p of profesionales) {
    const existente = await prisma.profesional.findUnique({ where: { id: p.id } });
    if (existente) {
      console.log(`   ⏭️  ${existente.nombre} (id ${p.id}) ya existe, no se toca`);
      continue;
    }
    await prisma.profesional.create({ data: p });
    console.log(`   ✅ ${p.nombre} creada con id ${p.id}`);
  }

  // Chequeo explícito: si Daniela no quedó en el id 1, el `@default(1)` del paso
  // siguiente le asignaría todo lo existente a la profesional equivocada.
  const daniela = await prisma.profesional.findUnique({ where: { id: 1 } });
  if (!daniela) {
    throw new Error('No existe la profesional id 1. El paso 3 de la migración depende de ella.');
  }
  console.log(`\n🎉 Listo. id 1 = ${daniela.nombre}`);
}

main()
  .catch((e) => {
    console.error('❌ Error cargando profesionales:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
