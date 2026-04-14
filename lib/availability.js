const prisma = require('./prisma');

/**
 * Calcula los horarios disponibles para una fecha y duración de servicio.
 * Soporta MÚLTIPLES RANGOS por día (ej: 9-13 y 15-19).
 */
async function obtenerHorariosDisponibles(fecha, duracionMinutos) {
  const fechaStr = fecha.toISOString().split('T')[0];

  // 1. Verificar si el día está bloqueado
  const bloqueado = await prisma.bloqueCerrado.findFirst({
    where: { fecha: new Date(fechaStr) }
  });
  if (bloqueado) return [];

  // 2. Obtener TODOS los rangos del día de semana
  const jsDay = fecha.getDay();
  const diaSemana = jsDay === 0 ? 6 : jsDay - 1;

  const rangos = await prisma.horarioConfig.findMany({
    where: { dia_semana: diaSemana, abierto: true },
    orderBy: { hora_inicio: 'asc' }
  });

  if (rangos.length === 0) return [];

  // 3. Obtener turnos existentes del día
  const turnosDelDia = await prisma.turno.findMany({
    where: {
      fecha: new Date(fechaStr),
      estado: 'confirmado'
    },
    orderBy: { hora_inicio: 'asc' }
  });

  // 4. Generar franjas horarias para CADA rango
  const horariosDisponibles = [];

  for (const rango of rangos) {
    const espacio = rango.espacio_entre_turnos_min || 0;
    const [inicioH, inicioM] = rango.hora_inicio.split(':').map(Number);
    const [finH, finM] = rango.hora_fin.split(':').map(Number);
    const inicioMin = inicioH * 60 + inicioM;
    const finMin = finH * 60 + finM;

    for (let min = inicioMin; min + duracionMinutos <= finMin; min += 30) {
      const slotInicio = minutosAHora(min);
      const slotFin = minutosAHora(min + duracionMinutos);

      const libre = !turnosDelDia.some(turno => {
        const turnoInicioMin = horaAMinutos(turno.hora_inicio);
        const turnoFinMin = horaAMinutos(turno.hora_fin);
        const turnoFinConEspacio = turnoFinMin + espacio;
        const slotInicioMin = min;
        const slotFinMin = min + duracionMinutos;

        return slotInicioMin < turnoFinConEspacio && slotFinMin > turnoInicioMin - espacio;
      });

      if (libre) {
        horariosDisponibles.push({
          hora_inicio: slotInicio,
          hora_fin: slotFin
        });
      }
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

function calcularHoraFin(horaInicio, duracionMinutos) {
  const min = horaAMinutos(horaInicio) + duracionMinutos;
  return minutosAHora(min);
}

/**
 * Verifica y reserva atómicamente (race condition safe).
 */
async function verificarYReservar(datos) {
  return prisma.$transaction(async (tx) => {
    const conflicto = await tx.turno.findFirst({
      where: {
        fecha: datos.fecha,
        estado: 'confirmado',
        OR: [
          { hora_inicio: { lte: datos.hora_inicio }, hora_fin: { gt: datos.hora_inicio } },
          { hora_inicio: { lt: datos.hora_fin }, hora_fin: { gte: datos.hora_fin } },
          { hora_inicio: { gte: datos.hora_inicio }, hora_fin: { lte: datos.hora_fin } }
        ]
      }
    });

    if (conflicto) {
      throw new Error('HORARIO_NO_DISPONIBLE');
    }

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
