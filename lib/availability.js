const prisma = require('./prisma');

/**
 * Calcula los horarios disponibles para una fecha y duración de servicio.
 * Soporta MÚLTIPLES RANGOS por día + INTERCALACIÓN de servicios.
 */
async function obtenerHorariosDisponibles(fecha, duracionMinutos, servicioId) {
  const fechaStr = fecha.toISOString().split('T')[0];

  // 1. Verificar bloqueos del día (día completo Y/O rangos horarios parciales)
  const bloqueosDia = await prisma.bloqueCerrado.findMany({
    where: { fecha: new Date(fechaStr) }
  });
  const bloqueoCompleto = bloqueosDia.some(b => !b.hora_inicio || !b.hora_fin);
  if (bloqueoCompleto) return [];
  const bloqueosParciales = bloqueosDia; // acá ya sabemos que ninguno es de día completo

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
      }) && !bloqueosParciales.some(b => {
        const bInicio = horaAMinutos(b.hora_inicio);
        const bFin = horaAMinutos(b.hora_fin);
        return slotInicioMin < bFin && slotFinMin > bInicio;
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

/**
 * Calcula los horarios disponibles para un BLOQUE CONTINUO de varios servicios.
 * El bloque se trata como un único turno sólido de `duracionTotalMinutos`:
 * NO hay intercalación adentro (es la misma clienta ocupando la silla todo el rato),
 * pero el bloque completo sí respeta el espacio entre turnos contra los demás turnos del día.
 */
async function obtenerHorariosDisponiblesBloque(fecha, duracionTotalMinutos) {
  const fechaStr = fecha.toISOString().split('T')[0];

  // 1. Bloqueos del día (día completo Y/O rangos horarios parciales)
  const bloqueosDia = await prisma.bloqueCerrado.findMany({
    where: { fecha: new Date(fechaStr) }
  });
  const bloqueoCompleto = bloqueosDia.some(b => !b.hora_inicio || !b.hora_fin);
  if (bloqueoCompleto) return [];
  const bloqueosParciales = bloqueosDia;

  // 2. Rangos del día de semana
  const jsDay = fecha.getDay();
  const diaSemana = jsDay === 0 ? 6 : jsDay - 1;

  const rangos = await prisma.horarioConfig.findMany({
    where: { dia_semana: diaSemana, abierto: true },
    orderBy: { hora_inicio: 'asc' }
  });
  if (rangos.length === 0) return [];

  // 3. Turnos existentes
  const turnosDelDia = await prisma.turno.findMany({
    where: { fecha: new Date(fechaStr), estado: 'confirmado' },
    orderBy: { hora_inicio: 'asc' }
  });

  // 4. Generar slots donde entra el bloque completo
  const horariosDisponibles = [];

  for (const rango of rangos) {
    const espacio = rango.espacio_entre_turnos_min || 0;
    const [inicioH, inicioM] = rango.hora_inicio.split(':').map(Number);
    const [finH, finM] = rango.hora_fin.split(':').map(Number);
    const inicioMin = inicioH * 60 + inicioM;
    const finMin = finH * 60 + finM;

    for (let min = inicioMin; min + duracionTotalMinutos <= finMin; min += 30) {
      const slotInicioMin = min;
      const slotFinMin = min + duracionTotalMinutos;

      // Chequeo de solapamiento puro (sin intercalación) contra todos los turnos
      const libre = !turnosDelDia.some(turno => {
        const turnoInicioMin = horaAMinutos(turno.hora_inicio);
        const turnoFinMin = horaAMinutos(turno.hora_fin);
        const turnoFinConEspacio = turnoFinMin + espacio;
        return slotInicioMin < turnoFinConEspacio && slotFinMin > turnoInicioMin - espacio;
      }) && !bloqueosParciales.some(b => {
        const bInicio = horaAMinutos(b.hora_inicio);
        const bFin = horaAMinutos(b.hora_fin);
        return slotInicioMin < bFin && slotFinMin > bInicio;
      });

      if (libre) {
        horariosDisponibles.push({
          hora_inicio: minutosAHora(min),
          hora_fin: minutosAHora(min + duracionTotalMinutos)
        });
      }
    }
  }

  return horariosDisponibles;
}

/**
 * Dado un array de items { servicio, extras, duracion } (duracion = servicio + sus extras)
 * elegidos juntos para una misma reserva, separa cuáles van SECUENCIALES (uno atrás del
 * otro, como hasta ahora) de cuáles son "intercalados": servicios compatibles con algún
 * servicio ancla (intercalable=true) que también fue elegido en el mismo bloque, y que por
 * lo tanto NO suman tiempo — comparten el horario del ancla.
 *
 * No limita por `max_simultaneos` (ese campo es para turnos de clientas distintas
 * compartiendo horario, un caso distinto). Acá se asume que el frontend ya limitó a
 * un compatible por ancla. Respeta `intercalar_desde_min` (a partir de qué minuto del ancla puede arrancar el compatible).
 *
 * Devuelve:
 * - secuenciales: items que se encadenan uno después del otro (incluye las anclas)
 * - intercalados: [{ item, anclaServicioId, offsetMin }] — comparten horario con su ancla
 * - duracionEfectivaPorId: { [servicioId]: minutos } — para las anclas, ya ajustada para
 *   que el bloque no corte antes de que termine el compatible que lleva adentro
 * - duracionTotal: suma de duracionEfectivaPorId de los secuenciales (duración real del bloque)
 */
function resolverBloqueConIntercalados(items) {
  const porServicioId = {};
  items.forEach(it => { porServicioId[it.servicio.id] = it; });

  // servicioId (intercalado) -> servicioId (ancla)
  const anclaDe = {};
  // Nota: acá NO se limita por `max_simultaneos` — ese campo se usa para el caso de
  // dos turnos de CLIENTAS DISTINTAS compartiendo horario (ver obtenerHorariosDisponibles
  // y verificarYReservar más abajo). En este flujo (una sola clienta reservando servicios
  // juntos en /multi) la pantalla "Aprovechá el rato" del frontend ya garantiza que como
  // máximo se elija un compatible por ancla.
  items.forEach(it => {
    if (!it.servicio.intercalable) return;
    const compatibles = it.servicio.servicios_compatibles || [];
    items.forEach(otro => {
      if (otro.servicio.id === it.servicio.id) return;
      if (anclaDe[otro.servicio.id]) return; // ya tiene ancla asignada
      if (!compatibles.includes(otro.servicio.id)) return;
      anclaDe[otro.servicio.id] = it.servicio.id;
    });
  });

  const intercalados = items.filter(it => anclaDe[it.servicio.id]);
  const secuenciales = items.filter(it => !anclaDe[it.servicio.id]);

  // Duración efectiva de cada secuencial (por defecto la suya; si es ancla de algo,
  // se estira para cubrir al intercalado que lleva adentro)
  const duracionEfectivaPorId = {};
  secuenciales.forEach(it => { duracionEfectivaPorId[it.servicio.id] = it.duracion; });

  intercalados.forEach(it => {
    const anclaId = anclaDe[it.servicio.id];
    const ancla = porServicioId[anclaId];
    const offset = ancla.servicio.intercalar_desde_min || 0;
    const necesaria = offset + it.duracion;
    if (necesaria > duracionEfectivaPorId[anclaId]) {
      duracionEfectivaPorId[anclaId] = necesaria;
    }
  });

  const duracionTotal = secuenciales.reduce((s, it) => s + duracionEfectivaPorId[it.servicio.id], 0);

  return {
    secuenciales,
    intercalados: intercalados.map(it => ({
      item: it,
      anclaServicioId: anclaDe[it.servicio.id],
      offsetMin: porServicioId[anclaDe[it.servicio.id]].servicio.intercalar_desde_min || 0
    })),
    duracionEfectivaPorId,
    duracionTotal
  };
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

/**
 * Verifica y reserva un BLOQUE de varios turnos consecutivos atómicamente.
 * - `turnosData`: array de objetos listos para crear (ya con hora_inicio/hora_fin de cada sub-turno).
 * - `rangoInicio` / `rangoFin`: límites del bloque completo (para el chequeo de conflicto).
 * Si cualquier parte del bloque choca con un turno existente, NO crea nada.
 * Los sub-turnos del propio bloque (por ejemplo un ancla y su intercalado) NO se chequean
 * entre sí — ese solapamiento es intencional.
 * Devuelve el array de turnos creados (con servicio incluido), ordenados.
 */
async function verificarYReservarBloque(turnosData, rangoInicio, rangoFin) {
  const fecha = turnosData[0].fecha;
  return prisma.$transaction(async (tx) => {
    // Conflicto = cualquier turno confirmado que se solape con el rango completo del bloque
    const conflicto = await tx.turno.findFirst({
      where: {
        fecha,
        estado: 'confirmado',
        OR: [
          { hora_inicio: { lte: rangoInicio }, hora_fin: { gt: rangoInicio } },
          { hora_inicio: { lt: rangoFin }, hora_fin: { gte: rangoFin } },
          { hora_inicio: { gte: rangoInicio }, hora_fin: { lte: rangoFin } }
        ]
      }
    });

    if (conflicto) {
      throw new Error('HORARIO_NO_DISPONIBLE');
    }

    const creados = [];
    for (const datos of turnosData) {
      const turno = await tx.turno.create({
        data: datos,
        include: { servicio: true }
      });
      creados.push(turno);
    }
    return creados;
  });
}

/**
 * Verifica y ACTUALIZA un turno existente atómicamente.
 * Igual que verificarYReservar pero excluye el propio turno (turnoId)
 * del chequeo de conflictos, para que no choque consigo mismo al editar.
 */
async function verificarYActualizar(turnoId, datos) {
  return prisma.$transaction(async (tx) => {
    const conflicto = await tx.turno.findFirst({
      where: {
        id: { not: turnoId },
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

          // Contar intercalados existentes (excluyendo el turno original Y el que se está editando)
          const yaIntercalados = await tx.turno.count({
            where: {
              fecha: datos.fecha,
              estado: 'confirmado',
              id: { notIn: [conflicto.id, turnoId] },
              hora_inicio: { gte: minutosAHora(ventanaDesde) },
            }
          });

          const maxSimult = (conflicto.servicio.max_simultaneos || 2) - 1;

          if (slotInicioMin >= ventanaDesde && slotFinMin <= turnoFinMin && yaIntercalados < maxSimult) {
            // Permitir la edición — es una intercalación válida
            const turno = await tx.turno.update({
              where: { id: turnoId },
              data: datos,
              include: { servicio: true }
            });
            return turno;
          }
        }
      }
      throw new Error('HORARIO_NO_DISPONIBLE');
    }

    const turno = await tx.turno.update({
      where: { id: turnoId },
      data: datos,
      include: { servicio: true }
    });

    return turno;
  });
}

module.exports = {
  obtenerHorariosDisponibles,
  obtenerHorariosDisponiblesBloque,
  resolverBloqueConIntercalados,
  calcularHoraFin,
  verificarYReservar,
  verificarYReservarBloque,
  verificarYActualizar,
  horaAMinutos,
  minutosAHora
};
