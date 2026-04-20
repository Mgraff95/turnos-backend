const prisma = require('./prisma');

/**
 * Calcula los horarios disponibles para una fecha y duración de servicio.
 * Soporta MÚLTIPLES RANGOS por día + INTERCALACIÓN de servicios.
 */
async function obtenerHorariosDisponibles(fecha, duracionMinutos, servicioId) {
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
    include: { servicio: true },
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
      const slotInicioMin = min;
      const slotFinMin = min + duracionMinutos;

      // Verificar contra cada turno existente
      const libre = !turnosDelDia.some(turno => {
        const turnoInicioMin = horaAMinutos(turno.hora_inicio);
        const turnoFinMin = horaAMinutos(turno.hora_fin);
        const turnoFinConEspacio = turnoFinMin + espacio;

        // Si el turno existente es intercalable y el servicio solicitado es compatible
        if (turno.servicio.intercalable && servicioId) {
          const compatibles = turno.servicio.servicios_compatibles || [];
          if (compatibles.includes(servicioId)) {
            // Ventana de intercalación: desde (turnoInicio + intercalar_desde_min) hasta turnoFin
            const ventanaDesde = turnoInicioMin + (turno.servicio.intercalar_desde_min || 0);
            const ventanaHasta = turnoFinMin;

            // Contar cuántos turnos ya están intercalados en esta ventana
            const yaIntercalados = turnosDelDia.filter(t2 => {
              if (t2.id === turno.id) return false;
              const t2Inicio = horaAMinutos(t2.hora_inicio);
              const t2Fin = horaAMinutos(t2.hora_fin);
              return t2Inicio >= ventanaDesde && t2Inicio < ventanaHasta;
            }).length;

            const maxSimult = (turno.servicio.max_simultaneos || 2) - 1; // -1 porque el turno original ya cuenta

            // Si el slot cabe dentro de la ventana y no se excede el máximo
            if (slotInicioMin >= ventanaDesde && slotFinMin <= ventanaHasta && yaIntercalados < maxSimult) {
              return false; // NO bloquear — es un slot intercalable válido
            }
          }
        }

        // Chequeo normal de solapamiento
        return slotInicioMin < turnoFinConEspacio && slotFinMin > turnoInicioMin - espacio;
      });

      if (libre) {
        // Verificar si este slot es un slot intercalado (para marcar en el frontend)
        const esIntercalado = turnosDelDia.some(turno => {
          if (!turno.servicio.intercalable || !servicioId) return false;
          const compatibles = turno.servicio.servicios_compatibles || [];
          if (!compatibles.includes(servicioId)) return false;
          const turnoInicioMin = horaAMinutos(turno.hora_inicio);
          const turnoFinMin = horaAMinutos(turno.hora_fin);
          const ventanaDesde = turnoInicioMin + (turno.servicio.intercalar_desde_min || 0);
          return slotInicioMin >= ventanaDesde && slotFinMin <= turnoFinMin;
        });

        horariosDisponibles.push({
          hora_inicio: slotInicio,
          hora_fin: slotFin,
          intercalado: esIntercalado
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
      },
      include: { servicio: true }
    });

    if (conflicto) {
      // Verificar si es un conflicto que se resuelve con intercalación
      if (conflicto.servicio.intercalable && datos.servicio_id) {
        const compatibles = conflicto.servicio.servicios_compatibles || [];
        if (compatibles.includes(datos.servicio_id)) {
          const turnoInicioMin = horaAMinutos(conflicto.hora_inicio);
          const turnoFinMin = horaAMinutos(conflicto.hora_fin);
          const ventanaDesde = turnoInicioMin + (conflicto.servicio.intercalar_desde_min || 0);
          const slotInicioMin = horaAMinutos(datos.hora_inicio);
          const slotFinMin = horaAMinutos(datos.hora_fin);

          // Contar intercalados existentes
          const yaIntercalados = await tx.turno.count({
            where: {
              fecha: datos.fecha,
              estado: 'confirmado',
              id: { not: conflicto.id },
              hora_inicio: { gte: minutosAHora(ventanaDesde) },
            }
          });

          const maxSimult = (conflicto.servicio.max_simultaneos || 2) - 1;

          if (slotInicioMin >= ventanaDesde && slotFinMin <= turnoFinMin && yaIntercalados < maxSimult) {
            // Permitir la reserva — es una intercalación válida
            const turno = await tx.turno.create({
              data: datos,
              include: { servicio: true }
            });
            return turno;
          }
        }
      }
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