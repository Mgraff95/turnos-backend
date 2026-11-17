// Armado del día, para los resúmenes de WhatsApp.
//
// Tres cuentas que antes vivían sueltas dentro de lib/scheduler.js, cuando el
// único resumen era el de Daniela y el estudio era una sola agenda. Están acá y
// puras porque con dos profesionales son justo las que se pueden equivocar:
// agrupar mal parte una reserva en dos, y el horario del estudio es la primera
// línea del mensaje que Daniela lee todas las noches.
//
// Las horas son strings "HH:MM" en todo el repo, así que se comparan con
// localeCompare y no hace falta pasarlas por Date.

// Junta los turnos de una misma reserva múltiple en un solo bloque. El turno
// suelto queda como grupo de 1, así el resto del código no distingue casos.
function agruparPorReserva(turnos) {
  if (!Array.isArray(turnos) || turnos.length === 0) return [];

  const grupos = new Map();
  // La clave del turno suelto es su posición, no su id: un turno sin
  // grupo_reserva es un grupo de uno siempre, y si la clave dependiera del id
  // dos turnos sin id se fundirían en un bloque sin que nada avise.
  turnos.forEach((turno, i) => {
    const clave = turno.grupo_reserva || `individual-${i}`;
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(turno);
  });

  return [...grupos.values()]
    .map(grupo => [...grupo].sort((a, b) => (a.orden_en_grupo || 0) - (b.orden_en_grupo || 0)))
    .sort((a, b) => a[0].hora_inicio.localeCompare(b[0].hora_inicio));
}

// De qué hora a qué hora está abierto el estudio: del primer turno del día al
// último que termina. El fin NO es el del último bloque: un turno largo que
// arranca temprano puede terminar después que el que empieza más tarde.
function horarioDelEstudio(grupos) {
  const turnos = grupos.flat();
  if (turnos.length === 0) return null;

  return {
    inicio: turnos.reduce((min, t) => (t.hora_inicio < min ? t.hora_inicio : min), turnos[0].hora_inicio),
    fin: turnos.reduce((max, t) => (t.hora_fin > max ? t.hora_fin : max), turnos[0].hora_fin)
  };
}

// Parte el día por profesional, en el orden en que se muestran en el panel.
// Solo aparecen las que tienen turnos: una sección vacía no le dice nada a
// nadie. El objeto `profesional` viaja tal como vino del turno, con su teléfono
// incluido si la consulta lo trajo: es lo que después necesita el envío.
function agendaPorProfesional(grupos) {
  const porId = new Map();

  for (const grupo of grupos) {
    const profesional = grupo[0].profesional || { id: grupo[0].profesional_id, nombre: null, orden: 0 };
    if (!porId.has(profesional.id)) porId.set(profesional.id, { profesional, grupos: [] });
    porId.get(profesional.id).grupos.push(grupo);
  }

  return [...porId.values()].sort((a, b) => {
    const porOrden = (a.profesional.orden || 0) - (b.profesional.orden || 0);
    if (porOrden !== 0) return porOrden;
    return String(a.profesional.nombre || '').localeCompare(String(b.profesional.nombre || ''));
  });
}

module.exports = { agruparPorReserva, horarioDelEstudio, agendaPorProfesional };
