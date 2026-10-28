const prisma = require('./prisma');
const { demasiadoCerca } = require('./fechas');
const { rangosQueAplican } = require('./horarios');
const { evaluarConflictoCruzado, errorDeConflictoCruzado } = require('./camilla');

// ── Guard de profesional ────────────────────────
//
// En Prisma, `profesional_id: undefined` dentro de un `where` NO filtra nada:
// la consulta devuelve las filas de todas las profesionales. Para los horarios
// eso significaría ofrecer la agenda de una para los servicios de otra, y para
// los conflictos significaría que dos profesionales se bloquean entre sí.
//
// Un olvido así es silencioso y caro, así que acá se corta.
function exigirProfesional(profesionalId) {
  if (profesionalId == null) {
    throw new Error('PROFESIONAL_REQUERIDA');
  }
}

// ── Holds de pago (reservas_pendientes) ────────
//
// Mientras una clienta paga, su horario queda congelado en reservas_pendientes.
// Todavía NO es un turno (el turno se crea recién con el pago aprobado), pero
// para efectos de disponibilidad ocupa el horario igual que uno.
//
// Simplificación deliberada: un hold bloquea TODO su rango para todos, sin
// aplicar la lógica de intercalación (PRP + Pies). Dura minutos, y replicar esa
// lógica acá no compensa la complejidad.
//
// El filtro por expira_at es lo que libera el slot solo: el cron de limpieza es
// higiene, no una dependencia. Si el cron no corre, el horario se libera igual.
// `profesionalId` es opcional: sin el, el where no filtra por agenda, que es lo
// que necesitan los listados del panel ("todos los pagos en curso"). Los usos de
// disponibilidad SIEMPRE lo pasan — un hold de una profesional no puede congelar
// la agenda de otra. El null del registro bloquea a todas (defensivo, para filas
// anteriores a esta migracion).
function whereHoldsActivos(fecha, profesionalId, usaCamilla = false) {
  const where = { fecha, estado: 'activa', expira_at: { gt: new Date() } };
  if (profesionalId != null) {
    // El filtro va en AND y NO en OR a proposito: los dos llamadores que
    // chequean conflicto (hayHoldEnConflicto mas abajo, y el checkout en
    // routes/pagos.js) combinan este where con la condicion de solapamiento
    // ASIGNANDO la clave OR. Si el filtro de profesional viviera ahi, esa
    // asignacion lo pisaria y el hold de una profesional pasaria a bloquear la
    // agenda de la otra, que es lo que esta rama existe para evitar.
    const deLaAgenda = [{ profesional_id: null }, { profesional_id: profesionalId }];
    // Y si lo que se pide usa la camilla, tambien la congela un hold de
    // camilla de otra profesional: hay una sola en el estudio.
    if (usaCamilla) deLaAgenda.push({ usa_camilla: true });
    where.AND = [{ OR: deLaAgenda }];
  }
  return where;
}

// Condición de solapamiento entre [inicio, fin) y un registro con hora_inicio/hora_fin.
// Mismo criterio que ya se usa para los turnos.
function orSolapamiento(inicio, fin) {
  return [
    { hora_inicio: { lte: inicio }, hora_fin: { gt: inicio } },
    { hora_inicio: { lt: fin }, hora_fin: { gte: fin } },
    { hora_inicio: { gte: inicio }, hora_fin: { lte: fin } }
  ];
}

// Trae los holds activos del día con la forma de un turno, para poder sumarlos
// a turnosDelDia y reusar la lógica de solapamiento sin reescribirla.
// El servicio ficticio con intercalable:false es lo que los deja fuera de la
// intercalación.
async function holdsActivosComoTurnos(fechaDate, profesionalId, usaCamilla) {
  const holds = await prisma.reservaPendiente.findMany({
    where: whereHoldsActivos(fechaDate, profesionalId, usaCamilla),
    select: { id: true, hora_inicio: true, hora_fin: true }
  });
  return holds.map(h => ({
    id: 'hold-' + h.id,
    hora_inicio: h.hora_inicio,
    hora_fin: h.hora_fin,
    servicio: {
      intercalable: false,
      servicios_compatibles: [],
      intercalar_desde_min: 0,
      max_simultaneos: 2
    }
  }));
}

// ¿Hay algún hold activo pisando este rango? Se usa dentro de las transacciones.
// `ignorarHoldId` permite que el propio hold no se bloquee a sí mismo cuando se
// crea el turno tras aprobarse su pago.
async function hayHoldEnConflicto(tx, fecha, horaInicio, horaFin, ignorarHoldId, profesionalId) {
  exigirProfesional(profesionalId);
  const where = Object.assign(whereHoldsActivos(fecha, profesionalId), {
    OR: orSolapamiento(horaInicio, horaFin)
  });
  if (ignorarHoldId) where.id = { not: ignorarHoldId };
  const hold = await tx.reservaPendiente.findFirst({ where, select: { id: true } });
  return !!hold;
}

// ── Los turnos que ocupan un horario ───────────
//
// Siempre los de la propia agenda, como siempre.
//
// Y ADEMAS, cuando el servicio que se pide usa la camilla, los turnos de
// camilla de las otras profesionales: hay una sola camilla en el estudio. Un
// servicio que no la usa (las unas) no los mira, y por eso las dos agendas
// siguen corriendo en paralelo para todo lo demas.
//
// Los ajenos vienen marcados con `ajeno: true` porque NO entran en la
// intercalacion: un hueco dentro del PRP de Elsa no es un hueco en la camilla,
// y pasarlos por esa logica abriria justo el agujero que esto viene a cerrar.
async function turnosQueOcupan(fechaDate, profesionalId, usaCamilla) {
  const where = { fecha: fechaDate, estado: 'confirmado' };
  if (usaCamilla) {
    where.OR = [{ profesional_id: profesionalId }, { servicio: { usa_camilla: true } }];
  } else {
    where.profesional_id = profesionalId;
  }
  const turnos = await prisma.turno.findMany({
    where,
    include: { servicio: true },
    orderBy: { hora_inicio: 'asc' }
  });
  return turnos.map(t => ({ ...t, ajeno: t.profesional_id !== profesionalId }));
}

// ── Cruces entre agendas, dentro de la transaccion ─
//
// La version que decide de verdad. turnosQueOcupan es para la pantalla: evita
// ofrecer un horario imposible, pero entre que la clienta lo ve y lo confirma
// puede entrar otro turno. Aca se vuelve a chequear con la base trabada.
//
// Resuelve usa_camilla leyendo el servicio y no confiando en el llamador: es el
// unico lugar por el que pasan los cinco caminos que crean turnos, asi que si
// alguno se olvidara de pasarlo, la regla igual se aplica.
//
// `cliente` son los datos de quien reserva (cliente_telefono / _nombre /
// _apellido), para la regla de que una persona no puede tener dos turnos
// solapados con profesionales distintas.
async function chequearCruces(tx, { fecha, horaInicio, horaFin, profesionalId, servicioId, cliente, ignorarTurnoIds }) {
  const servicio = servicioId
    ? await tx.servicio.findUnique({ where: { id: servicioId }, select: { usa_camilla: true } })
    : null;
  const usaCamilla = !!(servicio && servicio.usa_camilla);

  // Igual que con la profesional: un `cliente` sin telefono dejaria la regla
  // de "una persona no puede estar en dos sillas a la vez" sin efecto, y nadie
  // se enteraria. La regla aplica haya camilla o no, asi que se exige siempre.
  if (!cliente || !cliente.cliente_telefono) {
    throw new Error('CLIENTE_REQUERIDO');
  }

  const where = {
    fecha,
    estado: 'confirmado',
    profesional_id: { not: profesionalId },
    OR: orSolapamiento(horaInicio, horaFin)
  };
  // Solo cuando hay algo que excluir: en Prisma un `id: undefined` significa
  // "sin filtro", que es exactamente lo que se quiere en el otro caso.
  if (ignorarTurnoIds && ignorarTurnoIds.length > 0) where.id = { notIn: ignorarTurnoIds };

  const turnosAjenos = await tx.turno.findMany({
    where,
    include: {
      servicio: { select: { nombre: true, usa_camilla: true } },
      profesional: { select: { nombre: true } }
    }
  });

  const conflicto = evaluarConflictoCruzado({ turnosAjenos, usaCamilla, cliente });
  if (conflicto) throw errorDeConflictoCruzado(conflicto);

  // Un pago en curso de otra profesional por un servicio de camilla la congela
  // igual que un turno. Sin filtro de profesional a proposito: un hold de la
  // agenda propia ya lo freno hayHoldEnConflicto antes de llegar aca.
  if (usaCamilla) {
    const hold = await tx.reservaPendiente.findFirst({
      where: {
        fecha,
        estado: 'activa',
        expira_at: { gt: new Date() },
        usa_camilla: true,
        OR: orSolapamiento(horaInicio, horaFin)
      },
      select: { hora_inicio: true, hora_fin: true }
    });
    if (hold) throw errorDeConflictoCruzado({ codigo: 'CAMILLA_OCUPADA', turno: hold });
  }
}

/**
 * Calcula los horarios disponibles para una fecha y duración de servicio.
 * Soporta MÚLTIPLES RANGOS por día + INTERCALACIÓN de servicios.
 */
// `opciones.respetarAntelacion` (default true) filtra los slots que arrancan
// dentro de la ventana minima. El panel lo pasa en false: Daniela puede cargar
// un turno para esta tarde, una clienta no.
async function obtenerHorariosDisponibles(fecha, duracionMinutos, servicioId, profesionalId, opciones = {}) {
  const respetarAntelacion = opciones.respetarAntelacion !== false;
  // Si lo que se pide usa la camilla, los turnos de camilla de las otras
  // profesionales tambien ocupan: hay una sola. Lo pasan las dos rutas de
  // disponibilidad, que ya tienen el servicio en la mano. Esto es para no
  // ofrecer un horario que despues se va a rechazar; el chequeo que decide
  // es chequearCruces, en la transaccion.
  const usaCamilla = opciones.usaCamilla === true;
  // Sin profesional no se puede calcular nada: en Prisma un
  // `profesional_id: undefined` significa "sin filtro", así que la consulta de
  // horarios devolvería los rangos de TODAS y se ofrecerían los horarios de una
  // profesional para los servicios de otra. Preferimos que explote.
  exigirProfesional(profesionalId);

  const fechaStr = fecha.toISOString().split('T')[0];

  // 1. Verificar bloqueos del día (día completo Y/O rangos horarios parciales).
  //    Un bloqueo con profesional_id null cierra el estudio para todas.
  const bloqueosDia = await prisma.bloqueCerrado.findMany({
    where: {
      fecha: new Date(fechaStr),
      OR: [{ profesional_id: null }, { profesional_id: profesionalId }]
    }
  });
  const bloqueoCompleto = bloqueosDia.some(b => !b.hora_inicio || !b.hora_fin);
  if (bloqueoCompleto) return [];
  const bloqueosParciales = bloqueosDia; // acá ya sabemos que ninguno es de día completo

  // 2. Obtener TODOS los rangos del día de semana
  const jsDay = fecha.getDay();
  const diaSemana = jsDay === 0 ? 6 : jsDay - 1;

  // Si esta profesional no tiene rangos para este día, no trabaja: la lista
  // vacía de abajo es toda la lógica que eso necesita.
  // Una sola consulta trae el horario semanal de ese dia Y las excepciones de
  // esa fecha; rangosQueAplican decide cuales mandan.
  const rangos = rangosQueAplican(await prisma.horarioConfig.findMany({
    where: {
      abierto: true,
      profesional_id: profesionalId,
      OR: [
        { fecha: new Date(fechaStr) },
        { fecha: null, dia_semana: diaSemana }
      ]
    },
    orderBy: { hora_inicio: 'asc' }
  }));

  if (rangos.length === 0) return [];

  // 3. Obtener turnos existentes del día, SOLO de esta profesional. Los turnos
  //    de otra profesional son invisibles acá: es lo que hace que las agendas
  //    corran en paralelo sin bloquearse.
  const turnosDelDia = await turnosQueOcupan(new Date(fechaStr), profesionalId, usaCamilla);

  // Los holds de pago en curso ocupan el horario igual que un turno.
  const holds = await holdsActivosComoTurnos(new Date(fechaStr), profesionalId, usaCamilla);
  if (holds.length > 0) turnosDelDia.push(...holds);

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
        // Un turno ajeno (de otra profesional, ocupando la camilla) no
        // participa de la intercalacion: la camilla esta fisicamente tomada
        // todo su rango y adentro no hay hueco para meter otro servicio.
        if (turno.servicio.intercalable && servicioId && !turno.ajeno) {
          const compatibles = turno.servicio.servicios_compatibles || [];
          if (compatibles.includes(servicioId)) {
            // Ventana de intercalación: desde (turnoInicio + intercalar_desde_min) hasta turnoFin
            const ventanaDesde = turnoInicioMin + (turno.servicio.intercalar_desde_min || 0);
            const ventanaHasta = turnoFinMin;

            // Contar cuántos turnos ya están intercalados en esta ventana
            const yaIntercalados = turnosDelDia.filter(t2 => {
              if (t2.id === turno.id) return false;
              // Los ajenos no cuentan como intercalados: cada uno bloquea por
              // su cuenta en el chequeo normal de solapamiento de mas abajo.
              if (t2.ajeno) return false;
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
          if (!turno.servicio.intercalable || !servicioId || turno.ajeno) return false;
          const compatibles = turno.servicio.servicios_compatibles || [];
          if (!compatibles.includes(servicioId)) return false;
          const turnoInicioMin = horaAMinutos(turno.hora_inicio);
          const turnoFinMin = horaAMinutos(turno.hora_fin);
          const ventanaDesde = turnoInicioMin + (turno.servicio.intercalar_desde_min || 0);
          return slotInicioMin >= ventanaDesde && slotFinMin <= turnoFinMin;
        });

        // Un slot dentro de la ventana minima no se ofrece: la clienta nunca ve
        // un horario que despues le van a rechazar al reservar.
        if (respetarAntelacion && demasiadoCerca(fechaStr, slotInicio)) continue;

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
async function obtenerHorariosDisponiblesBloque(fecha, duracionTotalMinutos, profesionalId, opciones = {}) {
  const respetarAntelacion = opciones.respetarAntelacion !== false;
  // Si lo que se pide usa la camilla, los turnos de camilla de las otras
  // profesionales tambien ocupan: hay una sola. Lo pasan las dos rutas de
  // disponibilidad, que ya tienen el servicio en la mano. Esto es para no
  // ofrecer un horario que despues se va a rechazar; el chequeo que decide
  // es chequearCruces, en la transaccion.
  const usaCamilla = opciones.usaCamilla === true;
  exigirProfesional(profesionalId);

  const fechaStr = fecha.toISOString().split('T')[0];

  // 1. Bloqueos del día (día completo Y/O rangos horarios parciales)
  const bloqueosDia = await prisma.bloqueCerrado.findMany({
    where: {
      fecha: new Date(fechaStr),
      OR: [{ profesional_id: null }, { profesional_id: profesionalId }]
    }
  });
  const bloqueoCompleto = bloqueosDia.some(b => !b.hora_inicio || !b.hora_fin);
  if (bloqueoCompleto) return [];
  const bloqueosParciales = bloqueosDia;

  // 2. Rangos del día de semana
  const jsDay = fecha.getDay();
  const diaSemana = jsDay === 0 ? 6 : jsDay - 1;

  // Una sola consulta trae el horario semanal de ese dia Y las excepciones de
  // esa fecha; rangosQueAplican decide cuales mandan.
  const rangos = rangosQueAplican(await prisma.horarioConfig.findMany({
    where: {
      abierto: true,
      profesional_id: profesionalId,
      OR: [
        { fecha: new Date(fechaStr) },
        { fecha: null, dia_semana: diaSemana }
      ]
    },
    orderBy: { hora_inicio: 'asc' }
  }));
  if (rangos.length === 0) return [];

  // 3. Turnos existentes, solo de esta profesional
  const turnosDelDia = await turnosQueOcupan(new Date(fechaStr), profesionalId, usaCamilla);

  // Los holds de pago en curso ocupan el horario igual que un turno.
  const holds = await holdsActivosComoTurnos(new Date(fechaStr), profesionalId, usaCamilla);
  if (holds.length > 0) turnosDelDia.push(...holds);

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
        if (respetarAntelacion && demasiadoCerca(fechaStr, minutosAHora(min))) continue;

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
async function verificarYReservar(datos, opciones = {}) {
  return prisma.$transaction(async (tx) => {
    // Un hold activo bloquea el horario sin excepción: no participa de la
    // intercalación, así que se chequea antes que nada.
    if (await hayHoldEnConflicto(tx, datos.fecha, datos.hora_inicio, datos.hora_fin, opciones.ignorarHoldId, datos.profesional_id)) {
      throw new Error('HORARIO_NO_DISPONIBLE');
    }

    exigirProfesional(datos.profesional_id);

    // Cruces con la otra agenda: la camilla compartida y la propia clienta.
    await chequearCruces(tx, {
      fecha: datos.fecha,
      horaInicio: datos.hora_inicio,
      horaFin: datos.hora_fin,
      profesionalId: datos.profesional_id,
      servicioId: datos.servicio_id,
      cliente: datos
    });

    const conflicto = await tx.turno.findFirst({
      where: {
        fecha: datos.fecha,
        estado: 'confirmado',
        profesional_id: datos.profesional_id,
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
              profesional_id: datos.profesional_id,
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
async function verificarYReservarBloque(turnosData, rangoInicio, rangoFin, opciones = {}) {
  const fecha = turnosData[0].fecha;
  const profesionalId = turnosData[0].profesional_id;
  exigirProfesional(profesionalId);
  return prisma.$transaction(async (tx) => {
    // Un hold activo sobre el rango del bloque lo bloquea entero.
    if (await hayHoldEnConflicto(tx, fecha, rangoInicio, rangoFin, opciones.ignorarHoldId, profesionalId)) {
      throw new Error('HORARIO_NO_DISPONIBLE');
    }

    // Cruces con la otra agenda, uno por sub-turno y con SU propio rango: si
    // el bloque es PRP (camilla) de 10 a 11 mas unas de 11 a 12, la camilla
    // solo hace falta de 10 a 11, y chequear el bloque entero rechazaria de
    // mas. La clienta queda cubierta igual: los sub-turnos se encadenan sin
    // huecos, asi que entre todos cubren el bloque completo.
    for (const datos of turnosData) {
      await chequearCruces(tx, {
        fecha: datos.fecha,
        horaInicio: datos.hora_inicio,
        horaFin: datos.hora_fin,
        profesionalId,
        servicioId: datos.servicio_id,
        cliente: datos
      });
    }

    // Conflicto = cualquier turno confirmado DE ESTA PROFESIONAL que se solape
    // con el rango completo del bloque. Todos los turnosData comparten
    // profesional: el guard de lib/reservas.js lo garantiza.
    const conflicto = await tx.turno.findFirst({
      where: {
        fecha,
        estado: 'confirmado',
        profesional_id: profesionalId,
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
async function verificarYActualizar(turnoId, datos, opciones = {}) {
  return prisma.$transaction(async (tx) => {
    // Que Daniela no pueda pisar desde el panel un horario que se está pagando.
    if (await hayHoldEnConflicto(tx, datos.fecha, datos.hora_inicio, datos.hora_fin, opciones.ignorarHoldId, datos.profesional_id)) {
      throw new Error('HORARIO_NO_DISPONIBLE');
    }

    exigirProfesional(datos.profesional_id);

    // Igual que al reservar, pero sin mirarse a si mismo: mover un turno no
    // puede chocar contra el lugar que ese mismo turno esta dejando.
    await chequearCruces(tx, {
      fecha: datos.fecha,
      horaInicio: datos.hora_inicio,
      horaFin: datos.hora_fin,
      profesionalId: datos.profesional_id,
      servicioId: datos.servicio_id,
      // El PATCH publico solo manda fecha y hora, asi que los datos de la
      // clienta vienen por opciones, del turno que ya existe.
      cliente: opciones.cliente || datos,
      ignorarTurnoIds: [turnoId]
    });

    const conflicto = await tx.turno.findFirst({
      where: {
        id: { not: turnoId },
        fecha: datos.fecha,
        estado: 'confirmado',
        profesional_id: datos.profesional_id,
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
              profesional_id: datos.profesional_id,
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
  whereHoldsActivos,
  chequearCruces,
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
