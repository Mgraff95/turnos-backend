const prisma = require('./prisma');

/**
 * Calcula los horarios disponibles para una fecha y duración de servicio.
 * Tiene en cuenta: config del día, bloques cerrados, turnos existentes,
 * espacio entre turnos.
 */
async function obtenerHorariosDisponibles(fecha, duracionMinutos) {
  // 1. Verificar si el día está bloqueado
  const fechaStr = fecha.toISOString().split('T')[0];
  const bloqueado = await prisma.bloqueCerrado.findFirst({
    where: { fecha: new Date(fechaStr) }
  });
  if (bloqueado) return [];

  // 2. Obtener config del día de semana
  //    JS: 0=dom, 1=lun... Nosotros: 0=lun, 6=dom
  const jsDay = fecha.getDay(); // 0=dom
  const diaSemana = jsDay === 0 ? 6 : jsDay - 1; // convertir a 0=lun

  const config = await prisma.horarioConfig.findUnique({
    where: { dia_semana: diaSemana }
  });

  if (!config || !config.abierto) return [];

  // 3. Obtener turnos existentes del día
  const turnosDelDia = await prisma.turno.findMany({
    where: {
      fecha: new Date(fechaStr),
      estado: 'confirmado'
    },
    orderBy: { hora_inicio: 'asc' }
  });

  // 4. Generar franjas horarias posibles
  const espacio = config.espacio_entre_turnos_min || 0;
  const horariosDisponibles = [];

  const [inicioH, inicioM] = config.hora_inicio.split(':').map(Number);
  const [finH, finM] = config.hora_fin.split(':').map(Number);
  const inicioMin = inicioH * 60 + inicioM;
  const finMin = finH * 60 + finM;

  // Iterar cada 30 minutos (o podría ser configurable)
  for (let min = inicioMin; min + duracionMinutos <= finMin; min += 30) {
    const slotInicio = minutosAHora(min);
    const slotFin = minutosAHora(min + duracionMinutos);

    // Verificar que no se superponga con ningún turno existente
    const libre = !turnosDelDia.some(turno => {
      const turnoInicioMin = horaAMinutos(turno.hora_inicio);
      const turnoFinMin = horaAMinutos(turno.hora_fin);
      const turnoFinConEspacio = turnoFinMin + espacio;
      const slotInicioMin = min;
      const slotFinMin = min + duracionMinutos;

      // Hay conflicto si el slot se superpone con el turno + espacio
      return slotInicioMin < turnoFinConEspacio && slotFinMin > turnoInicioMin - espacio;
    });

    if (libre) {
      horariosDisponibles.push({
        hora_inicio: slotInicio,
        hora_fin: slotFin
      });
    }
  }

  return horariosDisponibles;
}

// ── Helpers ────────────────────────────────────
function minutosAHora(totalMin) {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function horaAMinutos(hora) {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Calcula hora_fin dado hora_inicio y duración del servicio
 */
function calcularHoraFin(horaInicio, duracionMinutos) {
  const min = horaAMinutos(horaInicio) + duracionMinutos;
  return minutosAHora(min);
}

/**
 * Verifica que un horario específico siga disponible (race condition check).
 * Usa una transacción para atomicidad.
 */
async function verificarYReservar(datos) {
  return prisma.$transaction(async (tx) => {
    // Verificar que no exista turno en ese horario
    const conflicto = await tx.turno.findFirst({
      where: {
        fecha: datos.fecha,
        estado: 'confirmado',
        OR: [
          {
            // El nuevo turno empieza durante uno existente
            hora_inicio: { lte: datos.hora_inicio },
            hora_fin: { gt: datos.hora_inicio }
          },
          {
            // El nuevo turno termina durante uno existente
            hora_inicio: { lt: datos.hora_fin },
            hora_fin: { gte: datos.hora_fin }
          },
          {
            // El nuevo turno envuelve a uno existente
            hora_inicio: { gte: datos.hora_inicio },
            hora_fin: { lte: datos.hora_fin }
          }
        ]
      }
    });

    if (conflicto) {
      throw new Error('HORARIO_NO_DISPONIBLE');
    }

    // Crear el turno dentro de la transacción
    const turno = await tx.turno.create({
      data: datos,
      include: { servicio: true }
    });

    return turno;
  });
}

module.exports = {
  obtenerHorariosDisponibles,
  calcularHoraFin,
  verificarYReservar,
  horaAMinutos,
  minutosAHora
};
